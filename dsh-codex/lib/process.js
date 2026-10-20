/**
 * Child-process layer: build the companion's environment, spawn it, stream its
 * output, and terminate its whole process tree. Also owns the temp files used
 * to hand prompt text to the companion without shell quoting.
 *
 * Depends only on Node builtins and the vendored process helper, so it is
 * unit-testable without a mounted Harness.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree as terminateVendoredProcessTree } from "../runtime/scripts/lib/process.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const COMPANION_SCRIPT = path.join(PACKAGE_ROOT, "runtime", "scripts", "codex-companion.mjs");

const DEFAULT_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const KILL_GRACE_MS = 3000;

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
  const pathParts = [path.dirname(input.codex.command), path.dirname(input.node.command), env.PATH ?? ""]
    .join(path.delimiter)
    .split(path.delimiter)
    .filter(Boolean);
  env.PATH = [...new Set(pathParts)].join(path.delimiter);
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
 * Terminate a child and its descendants. Platform and kill helpers are
 * injectable so tests can exercise the Windows and POSIX branches anywhere.
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
  terminateTreeImpl({ child, signal });
}

/** Append a chunk keeping only the last `cap` characters; report truncation. */
function appendBounded(current, chunk, cap) {
  const combined = current + chunk;
  if (combined.length <= cap) {
    return { text: combined, truncated: false };
  }
  return { text: combined.slice(combined.length - cap), truncated: true };
}

/**
 * Run the companion CLI as a detached process group.
 *
 * Aborting `signal` sends SIGTERM to the group, then SIGKILL after a grace
 * period. With `capture: false` output is only streamed through the callbacks
 * (the Harness job ring already bounds it).
 *
 * @param {{
 *   argv: string[];
 *   cwd: string;
 *   env: NodeJS.ProcessEnv;
 *   nodeCommand: string;
 *   signal?: AbortSignal;
 *   capture?: boolean;
 *   maxCaptureBytes?: number;
 *   onStdout?: (chunk: string) => void;
 *   onStderr?: (chunk: string) => void;
 * }} input
 * @returns {Promise<{ code: number | null; stdout: string; stderr: string; aborted: boolean; truncated: boolean; error?: Error }>}
 */
export function runCompanion(input) {
  if (!input.nodeCommand) {
    throw new Error("runCompanion requires nodeCommand (from resolveNode).");
  }
  const capture = input.capture !== false;
  const cap = Number.isFinite(input.maxCaptureBytes)
    ? Math.max(4096, input.maxCaptureBytes)
    : DEFAULT_MAX_CAPTURE_BYTES;

  return new Promise((resolve) => {
    const output = { stdout: "", stderr: "" };
    let truncated = false;
    let aborted = false;
    let settled = false;
    let killTimer = null;
    const child = spawn(input.nodeCommand, [COMPANION_SCRIPT, ...input.argv], {
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
      clearTimeout(killTimer);
      resolve({ code, stdout: output.stdout, stderr: output.stderr, aborted, truncated, error });
    };

    const pipe = (channel, callback) => {
      child[channel].setEncoding("utf8");
      child[channel].on("data", (chunk) => {
        if (capture) {
          const next = appendBounded(output[channel], chunk, cap);
          output[channel] = next.text;
          truncated = truncated || next.truncated;
        }
        callback?.(chunk);
      });
    };
    pipe("stdout", input.onStdout);
    pipe("stderr", input.onStderr);
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, undefined));

    const abort = () => {
      aborted = true;
      terminateTree(child);
      killTimer = setTimeout(() => terminateTree(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    if (input.signal?.aborted) {
      abort();
    } else {
      input.signal?.addEventListener("abort", abort, { once: true });
    }
  });
}

/**
 * Write prompt text to a private temp file so no prompt text is ever parsed as
 * a flag and no shell quoting is involved. Pair with removePromptFile.
 */
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
