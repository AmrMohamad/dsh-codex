/**
 * Locate the executables and directories the plugin needs: a Node.js runtime
 * for the vendored companion, the `codex` CLI, and the private data directory.
 *
 * Precedence everywhere: plugin config > documented env override > discovery.
 * A configured value that is broken fails loudly instead of silently falling
 * back to another runtime.
 *
 * Probes use spawnSync and therefore block the Host event loop; callers cache
 * the results (see createRunner in runtime.js) and discovery has a total time
 * budget.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const MIN_NODE = { major: 18, minor: 18 };
const RESOLUTION_BUDGET_MS = 12000;

function isExecutableFile(candidate) {
  if (!candidate || typeof candidate !== "string") {
    return false;
  }
  try {
    if (!fs.statSync(candidate).isFile()) {
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

function pathCandidates(fileName) {
  const entries = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return entries.map((entry) => path.join(entry, fileName));
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

function resolveUserPath(value) {
  return path.resolve(expandHome(value));
}

/**
 * Probe a node executable with `--version`. Electron binaries need
 * ELECTRON_RUN_AS_NODE=1 in `extraEnv`.
 *
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

/** @returns {string | null} the `codex --version` banner, or null when it is not a working Codex CLI */
function probeCodex(command, timeout) {
  try {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0 || !/codex/i.test(output)) {
      return null;
    }
    return output.trim().split("\n")[0] || "codex";
  } catch {
    return null;
  }
}

/** Resolve an explicitly configured node, failing loudly when it is unusable. */
function explicitNode(nodePath, label) {
  if (!isExecutableFile(nodePath)) {
    throw new Error(`${label} is not an executable file: ${nodePath}`);
  }
  const banner = probeNode(nodePath);
  if (!banner) {
    throw new Error(`${label} is not a usable Node.js >=18.18 runtime: ${nodePath}`);
  }
  return { command: nodePath, env: {}, source: `node ${banner}` };
}

function harnessRuntimeNodes() {
  const runtimesDir = path.join(os.homedir(), ".dsh", "dsh-runtimes");
  try {
    return fs
      .readdirSync(runtimesDir)
      .map((entry) => path.join(runtimesDir, entry, "dependencies", "node", "bin", "node"));
  } catch {
    return [];
  }
}

/**
 * Resolve a Node executable plus the environment needed to run it.
 *
 * The Harness desktop Host is an Electron process, so `process.execPath` is the
 * app binary rather than node; it is only usable with ELECTRON_RUN_AS_NODE=1
 * and is therefore the last resort.
 *
 * @param {{ nodePath?: string }} [config]
 * @returns {{ command: string; env: Record<string, string>; source: string }}
 */
export function resolveNode(config = {}) {
  if (config.nodePath) {
    return explicitNode(resolveUserPath(config.nodePath), "Configured nodePath");
  }
  if (process.env.CODEX_PLUGIN_NODE) {
    return explicitNode(resolveUserPath(process.env.CODEX_PLUGIN_NODE), "CODEX_PLUGIN_NODE");
  }

  const candidates = unique([
    process.env.DSH_DESKTOP_NODE_EXECUTABLE ? resolveUserPath(process.env.DSH_DESKTOP_NODE_EXECUTABLE) : null,
    process.versions.electron ? null : process.execPath,
    ...harnessRuntimeNodes(),
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

  if (process.versions.electron && probeNode(process.execPath, { ELECTRON_RUN_AS_NODE: "1" })) {
    return {
      command: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      source: "electron-run-as-node"
    };
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
  const configured = config.codexPath || process.env.CODEX_PLUGIN_CODEX_PATH;
  if (configured) {
    const explicitPath = resolveUserPath(configured);
    if (!isExecutableFile(explicitPath)) {
      throw new Error(`Configured codexPath is not an executable file: ${explicitPath}`);
    }
    const banner = probeCodex(explicitPath, 20000);
    if (!banner) {
      throw new Error(`Configured codexPath is not a working Codex CLI: ${explicitPath}`);
    }
    return { command: explicitPath, source: banner };
  }

  const candidates = unique([
    process.env.CODEX_BINARY ? resolveUserPath(process.env.CODEX_BINARY) : null,
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
    const banner = probeCodex(candidate, 6000);
    if (banner) {
      return { command: candidate, source: banner };
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
    return resolveUserPath(config.dataDir);
  }
  if (process.env.CODEX_PLUGIN_DATA_DIR) {
    return resolveUserPath(process.env.CODEX_PLUGIN_DATA_DIR);
  }
  // One profile-independent directory so the Desktop Host and the `dsh` CLI
  // share durable Codex job records. ($DSH_HOME is stable across profiles.)
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "codex-plugin-data");
}
