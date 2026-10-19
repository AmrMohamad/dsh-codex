/**
 * The runner: the single object the plugin uses to run the vendored Codex
 * companion (runtime/scripts/codex-companion.mjs).
 *
 * Resolution is lazy and cached per plugin instance, so a missing Codex CLI
 * only affects calls that actually need it, and reading durable job state
 * (`dataDir`) never requires a working Codex install. The vendored runtime and
 * its DSH patches are listed in ../NOTICE.
 */
import path from "node:path";
import process from "node:process";

import { buildChildEnv, runCompanion } from "./process.js";
import { resolveCodex, resolveDataDir, resolveNode } from "./resolve.js";

/**
 * @param {Record<string, any>} config plugin row config (codexPath, nodePath, dataDir, childEnv)
 */
export function createRunner(config = {}) {
  let node = null;
  let codex = null;
  let dataDir = null;

  const getDataDir = () => (dataDir ??= resolveDataDir(config));

  // Each executable is cached on its own: until Codex is installed, a failed
  // Codex lookup must not redo the (blocking) Node probes on every call, and a
  // failure never leaves a half-initialized runtime behind.
  const ready = () => {
    node ??= resolveNode(config);
    codex ??= resolveCodex(config);
    return { node, codex, dataDir: getDataDir() };
  };

  const env = (sessionId) => {
    const runtime = ready();
    return buildChildEnv({
      node: runtime.node,
      codex: runtime.codex,
      sessionId: sessionId ?? null,
      dataDir: runtime.dataDir,
      extraEnv: config.childEnv
    });
  };

  /**
   * @param {string[]} argv companion argv (see argv.js)
   * @param {{ cwd?: string; sessionId?: string | null; signal?: AbortSignal; capture?: boolean;
   *   maxCaptureBytes?: number; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }} [options]
   */
  const run = (argv, options = {}) => {
    const runtime = ready();
    return runCompanion({
      argv,
      cwd: path.resolve(options.cwd ?? process.cwd()),
      env: env(options.sessionId ?? null),
      nodeCommand: runtime.node.command,
      signal: options.signal,
      capture: options.capture,
      maxCaptureBytes: options.maxCaptureBytes,
      onStdout: options.onStdout,
      onStderr: options.onStderr
    });
  };

  return { ready, dataDir: getDataDir, env, run };
}
