/**
 * Process layer for the DeepSeek Harness Codex plugin.
 *
 * This module owns everything that talks to the vendored Codex companion
 * runtime: executable resolution, child environment construction, argument
 * construction, and child-process lifecycle. It deliberately depends only on
 * Node builtins and process.env so it can be unit-tested without a mounted
 * Harness.
 *
 * The companion runtime itself is vendored from the OpenAI Codex plugin for
 * Claude Code (Apache-2.0; see ../runtime/NOTICE and ../runtime/LICENSE) and is
 * patched for DeepSeek Harness in these places:
 *   - state root env var: CODEX_COMPANION_DATA_DIR (CLAUDE_PLUGIN_DATA fallback)
 *   - plugin manifest path: runtime/plugin.json
 *   - clientInfo name/title: DeepSeek Harness
 *   - optional `--job-id` override so Harness job ids and companion job
 *     records share one identity
 *   - `jobId` added to foreground JSON payloads
 *   - the Claude session-transfer command was removed
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree as terminateVendoredProcessTree } from "../runtime/scripts/lib/process.mjs";
import * as workspaceModule from "../runtime/scripts/lib/workspace.mjs";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RUNTIME_DIR = path.join(PACKAGE_ROOT, "runtime");
export const COMPANION_SCRIPT = path.join(RUNTIME_DIR, "scripts", "codex-companion.mjs");

const MIN_NODE = { major: 18, minor: 18 };
const RESOLUTION_BUDGET_MS = 12000;

function isExecutableFile(candidate) {
  if (!candidate || typeof candidate !== "string") {
    return false;
  }
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Expand a leading `~` or `~/` in user-supplied paths. YAML and environment
 * values receive no shell expansion, so `~/.dsh/x` would otherwise resolve
 * relative to the process working directory.
 */
export function expandHome(value) {
  const text = String(value ?? "");
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

const WORKSPACE_ROOT_CACHE_LIMIT = 200;
const workspaceRootCache = new Map();

/**
 * Resolve the git workspace root for a directory, caching the synchronous
 * `git rev-parse` per process. Progress updates call this repeatedly; an
 * uncached resolver spawns git on every state write.
 */
export function resolveWorkspaceRootCached(cwd) {
  const key = path.resolve(cwd);
  const cached = workspaceRootCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let root = key;
  try {
    root = workspaceModule.resolveWorkspaceRoot(key);
  } catch {
    root = key;
  }
  if (workspaceRootCache.size >= WORKSPACE_ROOT_CACHE_LIMIT) {
    workspaceRootCache.delete(workspaceRootCache.keys().next().value);
  }
  workspaceRootCache.set(key, root);
  return root;
}

function pathCandidates(fileName) {
  const entries = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return entries.map((entry) => path.join(entry, fileName));
}

/**
 * Probe a node executable by running `<candidate> --version` with an isolated
 * environment. Electron binaries need ELECTRON_RUN_AS_NODE=1.
 *
 * @param {string} command
 * @param {Record<string, string | undefined>} extraEnv
 * @returns {string | null} the version banner, or null when it is not a usable node
 */
export function probeNode(command, extraEnv = {}) {
  try {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 4000,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const match = /^v?(\d+)\.(\d+)\.\d+/.exec(output);
    if (!match) {
      return null;
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)) {
      return null;
    }
    return output.split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a Node executable plus the environment needed to run it.
 *
 * The Harness desktop Host is an Electron process, so `process.execPath` is the
 * app binary rather than node. In that case it is only usable with
 * ELECTRON_RUN_AS_NODE=1. A standalone `node` (Harness-provided runtime, PATH,
 * or the user's own) is preferred because it needs no special handling.
 *
 * @param {{ nodePath?: string }} [config]
 * @returns {{ command: string; env: Record<string, string>; source: string }}
 */
export function resolveNode(config = {}) {
  if (config.nodePath) {
    const nodePath = path.resolve(expandHome(config.nodePath));
    if (!isExecutableFile(nodePath)) {
      throw new Error(`Configured nodePath is not an executable file: ${nodePath}`);
    }
    const banner = probeNode(nodePath);
    if (!banner) {
      throw new Error(`Configured nodePath is not a usable Node.js >=18.18 runtime: ${config.nodePath}`);
    }
    return { command: nodePath, env: {}, source: `node ${banner}` };
  }

  // A documented CODEX_PLUGIN_NODE override is authoritative: a broken value
  // fails loudly instead of silently falling back to another runtime.
  if (process.env.CODEX_PLUGIN_NODE) {
    const envNode = path.resolve(expandHome(process.env.CODEX_PLUGIN_NODE));
    if (!isExecutableFile(envNode)) {
      throw new Error(`CODEX_PLUGIN_NODE is not an executable file: ${envNode}`);
    }
    const banner = probeNode(envNode);
    if (!banner) {
      throw new Error(`CODEX_PLUGIN_NODE is not a usable Node.js >=18.18 runtime: ${envNode}`);
    }
    return { command: envNode, env: {}, source: `node ${banner}` };
  }

  const explicit = [
    process.env.DSH_DESKTOP_NODE_EXECUTABLE
      ? path.resolve(expandHome(process.env.DSH_DESKTOP_NODE_EXECUTABLE))
      : null
  ];

  const homeNode = path.join(os.homedir(), ".dsh");
  const runtimeNodes = [];
  try {
    const runtimesDir = path.join(homeNode, "dsh-runtimes");
    for (const entry of fs.readdirSync(runtimesDir)) {
      runtimeNodes.push(path.join(runtimesDir, entry, "dependencies", "node", "bin", "node"));
    }
  } catch {
    // No Harness runtime cache; ignore.
  }

  const candidates = unique([
    ...explicit,
    process.versions.electron ? null : process.execPath,
    ...runtimeNodes,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    ...pathCandidates("node")
  ]);

  const deadline = Date.now() + RESOLUTION_BUDGET_MS;
  for (const candidate of candidates) {
    if (Date.now() > deadline) {
      break;
    }
    if (!isExecutableFile(candidate)) {
      continue;
    }
    const banner = probeNode(candidate);
    if (banner) {
      return { command: candidate, env: {}, source: `node ${banner}` };
    }
  }

  // Last resort: the Electron binary running as node.
  if (process.versions.electron) {
    if (probeNode(process.execPath, { ELECTRON_RUN_AS_NODE: "1" })) {
      return {
        command: process.execPath,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        source: "electron-run-as-node"
      };
    }
  }

  throw new Error(
    "Could not find a Node.js runtime (>=18.18) to run the Codex companion. " +
      "Set the plugin's `nodePath` config to an absolute node executable."
  );
}

/**
 * Resolve the `codex` CLI. The Harness Host often starts with a minimal PATH
 * (for example when launched from Finder), so well-known install locations are
 * checked in addition to PATH.
 *
 * @param {{ codexPath?: string }} [config]
 * @returns {{ command: string; source: string }}
 */
export function resolveCodex(config = {}) {
  // Precedence: plugin config > documented env override > legacy env > discovery.
  const explicitPath = config.codexPath
    ? path.resolve(expandHome(config.codexPath))
    : process.env.CODEX_PLUGIN_CODEX_PATH
      ? path.resolve(expandHome(process.env.CODEX_PLUGIN_CODEX_PATH))
      : null;
  if (explicitPath) {
    if (!isExecutableFile(explicitPath)) {
      throw new Error(`Configured codexPath is not an executable file: ${explicitPath}`);
    }
    const result = spawnSync(explicitPath, ["--version"], {
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0 || !/codex/i.test(output)) {
      throw new Error(`Configured codexPath is not a working Codex CLI: ${explicitPath}`);
    }
    return { command: explicitPath, source: output.trim().split("\n")[0] || "codex" };
  }

  const candidates = unique([
    process.env.CODEX_BINARY ? path.resolve(expandHome(process.env.CODEX_BINARY)) : null,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
    path.join(os.homedir(), ".bun", "bin", "codex"),
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
    ...pathCandidates("codex")
  ]);

  const deadline = Date.now() + RESOLUTION_BUDGET_MS;
  for (const candidate of candidates) {
    if (Date.now() > deadline) {
      break;
    }
    if (!isExecutableFile(candidate)) {
      continue;
    }
    try {
      const result = spawnSync(candidate, ["--version"], {
        encoding: "utf8",
        timeout: 6000,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.status === 0 && /codex/i.test(output)) {
        return { command: candidate, source: output.trim().split("\n")[0] || "codex" };
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    "The Codex CLI was not found. Install it with `npm install -g @openai/codex`, " +
      "then run the codex_setup tool. You can also set the plugin's `codexPath` config."
  );
}

/**
 * Resolve the plugin's private data directory (companion state, job records,
 * broker session files). It must be writable and stable across restarts.
 *
 * @param {{ dataDir?: string }} [config]
 * @returns {string}
 */
export function resolveDataDir(config = {}) {
  if (config.dataDir) {
    return path.resolve(expandHome(config.dataDir));
  }
  if (process.env.CODEX_PLUGIN_DATA_DIR) {
    return path.resolve(expandHome(process.env.CODEX_PLUGIN_DATA_DIR));
  }
  // One profile-independent directory so the Desktop Host and the `dsh` CLI
  // share durable Codex job records. ($DSH_HOME is stable across profiles.)
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "codex-plugin-data");
}

/**
 * Build the environment for a companion child process.
 *
 * @param {{
 *   node: { command: string; env: Record<string, string> };
 *   codex: { command: string };
 *   sessionId?: string | null;
 *   dataDir: string;
 *   extraEnv?: Record<string, string | undefined>;
 * }} input
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv(input) {
  const env = { ...process.env, ...input.node.env, ...(input.extraEnv ?? {}) };
  const pathParts = [
    path.dirname(input.codex.command),
    path.dirname(input.node.command),
    env.PATH ?? ""
  ].filter(Boolean);
  env.PATH = unique(pathParts.join(path.delimiter).split(path.delimiter)).join(path.delimiter);
  env.CODEX_COMPANION_DATA_DIR = input.dataDir;
  // The vendored companion spawns the CLI by name; pin the exact resolved
  // executable so wrappers/versioned names are honored.
  env.CODEX_COMPANION_CODEX_BIN = input.codex.command;
  if (input.sessionId) {
    env.CODEX_COMPANION_SESSION_ID = input.sessionId;
  }
  // Keep the vendored runtime's internal node spawns (broker, background
  // worker) on the same node executable rather than an Electron app binary.
  if (input.node.env.ELECTRON_RUN_AS_NODE) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

/**
 * Terminate a child and its descendants. Exported for tests so the Windows and
 * POSIX branches can be exercised without running on that platform.
 */
export function terminateTreeImpl(input) {
  const { child, signal = "SIGTERM" } = input;
  const platform = input.platform ?? process.platform;
  const killTree = input.killTree ?? terminateVendoredProcessTree;
  const killProcess = input.killProcess ?? process.kill;
  if (!child || child.exitCode !== null) {
    return;
  }
  if (platform === "win32") {
    // Windows has no process groups; the vendored helper uses taskkill /T /F.
    try {
      killTree(child.pid);
      return;
    } catch {
      // Fall through to the direct kill.
    }
  }
  try {
    if (child.pid) {
      // The child was spawned detached, so its pid is a process-group leader.
      killProcess(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to the direct kill.
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function terminateTree(child, signal = "SIGTERM") {
  return terminateTreeImpl({ child, signal });
}

const DEFAULT_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

/** Append a chunk keeping only the last `cap` characters; report truncation. */
function appendBounded(current, chunk, cap) {
  const combined = current + chunk;
  if (combined.length <= cap) {
    return { text: combined, truncated: false };
  }
  return { text: combined.slice(combined.length - cap), truncated: true };
}

/**
 * Run the companion CLI.
 *
 * @param {{
 *   argv: string[];
 *   cwd: string;
 *   env: NodeJS.ProcessEnv;
 *   signal?: AbortSignal;
 *   onStdout?: (chunk: string) => void;
 *   onStderr?: (chunk: string) => void;
 *   nodeCommand: string;
 * }} input
 * @returns {Promise<{ code: number | null; stdout: string; stderr: string; aborted: boolean; error?: Error }>}
 */
export function runCompanion(input) {
  const nodeCommand = input.nodeCommand;
  if (!nodeCommand) {
    throw new Error("runCompanion requires nodeCommand (from resolveNode).");
  }

  const capture = input.capture !== false;
  const cap = Number.isFinite(input.maxCaptureBytes)
    ? Math.max(4096, input.maxCaptureBytes)
    : DEFAULT_MAX_CAPTURE_BYTES;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let aborted = false;
    let settled = false;
    let killTimer = null;
    const child = spawn(nodeCommand, [COMPANION_SCRIPT, ...input.argv], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const finish = (code, error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      resolve({ code, stdout, stderr, aborted, truncated, error });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (capture) {
        const next = appendBounded(stdout, chunk, cap);
        stdout = next.text;
        truncated = truncated || next.truncated;
      }
      input.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (capture) {
        const next = appendBounded(stderr, chunk, cap);
        stderr = next.text;
        truncated = truncated || next.truncated;
      }
      input.onStderr?.(chunk);
    });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, undefined));

    if (input.signal) {
      if (input.signal.aborted) {
        aborted = true;
        terminateTree(child);
      } else {
        input.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            terminateTree(child);
            killTimer = setTimeout(() => terminateTree(child, "SIGKILL"), 3000);
            killTimer.unref?.();
          },
          { once: true }
        );
      }
    }
  });
}

/** Clean a companion rendered output for model consumption. */
export function cleanOutput(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Parse a JSON document printed by the companion (with `--json`). */
export function writePromptFile(prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-codex-prompt-"));
  const file = path.join(dir, "prompt.txt");
  fs.writeFileSync(file, String(prompt), "utf8");
  return file;
}

export function removePromptFile(file) {
  if (!file) {
    return;
  }
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

/* ------------------------------------------------------------------------- *
 * Companion argument builders. Every builder returns argv after `node
 * codex-companion.mjs`, and always pins `--cwd` explicitly.
 * ------------------------------------------------------------------------- */

export function reviewArgv(options) {
  const argv = ["review", "--cwd", options.cwd];
  if (options.base) argv.push("--base", String(options.base));
  if (options.scope) argv.push("--scope", String(options.scope));
  if (options.model) argv.push("--model", String(options.model));
  if (options.jobId) argv.push("--job-id", String(options.jobId));
  return argv;
}

export function adversarialReviewArgv(options) {
  const argv = ["adversarial-review", "--cwd", options.cwd];
  if (options.base) argv.push("--base", String(options.base));
  if (options.scope) argv.push("--scope", String(options.scope));
  if (options.model) argv.push("--model", String(options.model));
  if (options.jobId) argv.push("--job-id", String(options.jobId));
  if (options.focusFile) argv.push("--focus-file", options.focusFile);
  return argv;
}

/**
 * Task argv. The natural-language prompt is passed through a temp file so no
 * prompt text is ever parsed as a flag and no shell quoting is involved.
 */
export function taskArgv(options) {
  const argv = ["task", "--cwd", options.cwd];
  if (options.promptFile) {
    argv.push("--prompt-file", options.promptFile);
  }
  if (options.model) argv.push("--model", String(options.model));
  if (options.effort) argv.push("--effort", String(options.effort));
  if (options.write) argv.push("--write");
  if (options.resumeLast) argv.push("--resume-last");
  if (options.jobId) argv.push("--job-id", String(options.jobId));
  return argv;
}

export function setupArgv(options = {}) {
  return ["setup", "--cwd", options.cwd];
}

export function statusArgv(options = {}) {
  const argv = ["status", "--cwd", options.cwd];
  if (options.jobId) argv.push(String(options.jobId));
  if (options.all) argv.push("--all");
  if (options.wait) argv.push("--wait");
  if (options.timeoutMs) argv.push("--timeout-ms", String(options.timeoutMs));
  return argv;
}

export function resultArgv(options = {}) {
  const argv = ["result", "--cwd", options.cwd];
  if (options.jobId) argv.push(String(options.jobId));
  return argv;
}

export function cancelArgv(options = {}) {
  const argv = ["cancel", "--cwd", options.cwd];
  if (options.jobId) argv.push(String(options.jobId));
  return argv;
}

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Find a durable companion job record by id across every workspace state
 * directory under the plugin data dir. Used as a fallback when `codex_result`
 * is called from a different working directory than the run used.
 *
 * @param {string} dataDir
 * @param {string} jobId
 * @returns {Record<string, any> | null}
 */
export function findStoredCodexJob(dataDir, jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId) || jobId.includes("..")) {
    return null;
  }
  const stateRoot = path.join(dataDir, "state");
  let entries;
  try {
    entries = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const file = path.join(stateRoot, entry.name, "jobs", `${jobId}.json`);
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // Not in this workspace's state directory; keep looking.
    }
  }
  return null;
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalStoredJob(job) {
  return Boolean(job) && TERMINAL_JOB_STATUSES.has(String(job.status ?? ""));
}

/**
 * Render a durable job record for the model/user. Running jobs never render a
 * stale partial body; failed/cancelled jobs render their summary and error
 * instead of whatever text happened to be in `rendered`.
 */
function storedJobBody(job) {
  if (typeof job?.rendered === "string" && job.rendered.trim()) {
    return cleanOutput(job.rendered);
  }
  if (typeof job?.result === "string" && job.result.trim()) {
    return cleanOutput(job.result);
  }
  if (job?.result && typeof job.result === "object") {
    try {
      const json = JSON.stringify(job.result, null, 2);
      return json.length > 8000 ? `${json.slice(0, 8000)}\n…(truncated)` : json;
    } catch {
      return "";
    }
  }
  return cleanOutput(job?.summary || "");
}

export function renderStoredCodexJob(job) {
  const status = String(job?.status ?? "");
  const lines = [];
  if (status === "completed") {
    const body = storedJobBody(job);
    if (body) {
      lines.push(body);
    }
  } else {
    const summary = cleanOutput(job?.summary || "");
    if (summary) {
      lines.push(summary);
    }
    const error = cleanOutput(job?.errorMessage || job?.detail || "");
    if (error) {
      lines.push("", `Error: ${error}`);
    }
  }
  const meta = [];
  meta.push(`Status: ${status || "unknown"}`);
  if (job?.id) {
    meta.push(`Codex job: ${job.id}`);
  }
  if (job?.threadId) {
    meta.push(`Codex session ID: ${job.threadId}`);
    meta.push(`Resume in Codex: codex resume ${job.threadId}`);
  }
  lines.push("", ...meta);
  return lines.join("\n").trim() || "(no stored Codex output)";
}

/**
 * List durable job records across every workspace state directory, newest
 * first. Used to keep Codex job ids and status visible across working
 * directories and DSH sessions.
 *
 * @param {string} dataDir
 * @param {{ sessionId?: string | null; limit?: number; terminalOnly?: boolean }} [options]
 * @returns {Record<string, any>[]}
 */
export function listStoredCodexJobs(dataDir, options = {}) {
  const stateRoot = path.join(dataDir, "state");
  let entries;
  try {
    entries = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 8;
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const jobsDir = path.join(stateRoot, entry.name, "jobs");
    let files;
    try {
      files = fs.readdirSync(jobsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const job = JSON.parse(fs.readFileSync(path.join(jobsDir, file), "utf8"));
        if (!job || typeof job.id !== "string" || job.id !== file.slice(0, -5)) {
          continue;
        }
        if (options.sessionId && job.sessionId !== options.sessionId) {
          continue;
        }
        if (options.terminalOnly && !isTerminalStoredJob(job)) {
          continue;
        }
        jobs.push(job);
      } catch {
        // Ignore unreadable or partially-written records.
      }
    }
  }
  jobs.sort((left, right) =>
    String(right.updatedAt ?? right.completedAt ?? right.createdAt ?? "").localeCompare(
      String(left.updatedAt ?? left.completedAt ?? left.createdAt ?? "")
    )
  );
  return jobs.slice(0, limit);
}

/** Render a compact multi-job list (cross-workspace status fallback). */
export function renderStoredCodexJobList(jobs, options = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return "No Codex job records found.";
  }
  const lines = [options.title ?? "Codex jobs for this session:", ""];
  for (const job of jobs) {
    const summary = cleanOutput(job.summary || job.rendered || "").split("\n")[0].slice(0, 96);
    lines.push(`- ${job.id} [${job.kind ?? "job"}] ${job.status ?? "unknown"}${summary ? ` — ${summary}` : ""}`);
  }
  lines.push("", "Read one with codex_result <job id>.");
  return lines.join("\n");
}

/**
 * Resolve the runtime once and expose a small runner. Resolution is lazy so a
 * missing Codex CLI only affects tool calls that actually need it.
 *
 * @param {Record<string, any>} config
 */
export function createRunner(config = {}) {
  let cached = null;
  let dataDirCache = null;
  // Reading durable job state must not require a working Codex installation.
  const dataDir = () => {
    if (dataDirCache === null) {
      dataDirCache = resolveDataDir(config);
    }
    return dataDirCache;
  };
  const ready = () => {
    if (cached) {
      return cached;
    }
    // Resolve everything before publishing the cache: a failed Codex
    // resolution must not leave a half-initialized runtime that can never
    // recover without reloading the plugin.
    const node = resolveNode(config);
    const codex = resolveCodex(config);
    const dir = dataDir();
    cached = { node, codex, dataDir: dir };
    return cached;
  };
  return {
    ready,
    dataDir,
    env(sessionId) {
      const runtime = ready();
      return buildChildEnv({
        node: runtime.node,
        codex: runtime.codex,
        sessionId: sessionId ?? null,
        dataDir: runtime.dataDir,
        extraEnv: config.childEnv
      });
    },
    run(argv, options = {}) {
      const runtime = ready();
      return runCompanion({
        argv,
        cwd: path.resolve(options.cwd ?? process.cwd()),
        env: this.env(options.sessionId ?? null),
        nodeCommand: runtime.node.command,
        signal: options.signal,
        capture: options.capture,
        maxCaptureBytes: options.maxCaptureBytes,
        onStdout: options.onStdout,
        onStderr: options.onStderr
      });
    }
  };
}
