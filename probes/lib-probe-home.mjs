/**
 * Probe helper: Codex refuses to boot when its $CODEX_HOME state DB is not
 * writable (e.g. under the agent file sandbox). Probes therefore run against a
 * temporary CODEX_HOME with a copy of the user's readable auth.json.
 *
 * Security: only auth.json is copied (mode 0600), never printed. Delete the
 * directory when done: rm -rf /tmp/codex-probe-home
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export function ensureProbeCodexHome(options = {}) {
  const sourceHome = options.sourceHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const probeHome = options.probeHome ?? process.env.CODEX_PROBE_HOME ?? path.join(os.tmpdir(), "codex-probe-home");
  fs.mkdirSync(probeHome, { recursive: true });

  const authSource = path.join(sourceHome, "auth.json");
  const authTarget = path.join(probeHome, "auth.json");
  if (!fs.existsSync(authTarget) && fs.existsSync(authSource)) {
    fs.copyFileSync(authSource, authTarget);
    fs.chmodSync(authTarget, 0o600);
  }

  // Optionally copy the real config.toml to probe user-config behavior. Off by
  // default: a fresh home keeps model/provider defaults out of the comparison.
  if (options.copyConfig) {
    const configSource = path.join(sourceHome, "config.toml");
    const configTarget = path.join(probeHome, "config.toml");
    if (!fs.existsSync(configTarget) && fs.existsSync(configSource)) {
      fs.copyFileSync(configSource, configTarget);
      fs.chmodSync(configTarget, 0o600);
    }
  }

  return probeHome;
}

export function probeEnv(options = {}) {
  return { ...process.env, CODEX_HOME: ensureProbeCodexHome(options) };
}
