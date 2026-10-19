#!/usr/bin/env node
/**
 * End-to-end compatibility probe: run the UNMODIFIED plugin client code
 * (codex-plugin-cc/plugins/codex/scripts/lib/app-server.mjs + codex.mjs)
 * against the installed Codex 0.163 app-server.
 *
 * Exercises the plugin's real transports:
 *   - broker path: CodexAppServerClient.connect() -> app-server-broker.mjs
 *     (spawned by broker-lifecycle.mjs, custom unix socket)
 *   - getCodexAuthStatus() -> account/read + config/read through the broker
 *   - runAppServerTurn() -> thread/start + thread/name/set + turn/start +
 *     notification capture (one cheap model call: "Reply with exactly: OK")
 *   - findLatestTaskThread() -> thread/list with the plugin's sourceKinds filter
 *
 * Requires CODEX_HOME writable. Run with the probe helper's temp home:
 *   CODEX_HOME=/tmp/codex-probe-home node probes/probe-plugin-client.mjs
 * or let the script create/copy it automatically (see lib-probe-home.mjs).
 *
 * Run: node probes/probe-plugin-client.mjs [--report <path>]
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ensureProbeCodexHome } from "./lib-probe-home.mjs";

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(PROBE_DIR, "..");
const PLUGIN_DIR = path.join(WORKSPACE_ROOT, "codex-plugin-cc", "plugins", "codex");

async function main() {
  const args = { report: path.join(PROBE_DIR, "report-plugin-client.json") };
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--report") args.report = path.resolve(process.argv[++i]);
  }

  // The plugin inherits process.env when spawning codex, so point CODEX_HOME at
  // a writable probe home (the real ~/.codex is read-only under the agent
  // sandbox). In an unsandboxed shell this line can be omitted.
  const probeHome = ensureProbeCodexHome();
  process.env.CODEX_HOME = probeHome;

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-plugin-client-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "# plugin client probe\n");

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      cwd,
      codexHome: probeHome,
      pluginDir: path.relative(WORKSPACE_ROOT, PLUGIN_DIR),
      codexVersion: "see getCodexAvailability"
    },
    availability: null,
    authStatus: null,
    turn: null,
    findLatestTaskThread: null,
    brokerSession: null,
    errors: []
  };

  const { getCodexAvailability, getCodexAuthStatus, runAppServerTurn, findLatestTaskThread } = await import(
    path.join(PLUGIN_DIR, "scripts/lib/codex.mjs")
  );
  const { loadBrokerSession, sendBrokerShutdown } = await import(
    path.join(PLUGIN_DIR, "scripts/lib/broker-lifecycle.mjs")
  );

  try {
    report.availability = getCodexAvailability(cwd);
  } catch (error) {
    report.errors.push(`getCodexAvailability: ${error.message}`);
  }

  const progress = [];
  try {
    report.authStatus = await getCodexAuthStatus(cwd, { env: process.env });
  } catch (error) {
    report.errors.push(`getCodexAuthStatus: ${error.message}`);
  }

  try {
    report.brokerSession = loadBrokerSession(cwd);
  } catch (error) {
    report.errors.push(`loadBrokerSession: ${error.message}`);
  }

  try {
    const result = await runAppServerTurn(cwd, {
      prompt: "Reply with exactly: OK",
      sandbox: "read-only",
      persistThread: true,
      threadName: "Codex Companion Task: plugin-client probe",
      onProgress: (update) => progress.push(update)
    });
    report.turn = {
      status: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      finalMessage: result.finalMessage,
      turnStatus: result.turn?.status ?? null,
      stderr: result.stderr,
      touchedFiles: result.touchedFiles,
      commandExecutions: result.commandExecutions?.length ?? null,
      reasoningSummaryLength: result.reasoningSummary?.length ?? null,
      progressEvents: progress
    };
  } catch (error) {
    report.errors.push(`runAppServerTurn: ${error.message}`);
    report.turn = { error: error.message, progressEvents: progress };
  }

  try {
    const found = await findLatestTaskThread(cwd);
    report.findLatestTaskThread = found
      ? { id: found.id, name: found.name ?? null, ephemeral: found.ephemeral, source: found.source }
      : null;
  } catch (error) {
    report.errors.push(`findLatestTaskThread: ${error.message}`);
  }

  // Shut down the plugin's broker process (writes only to the temp session dir).
  try {
    const session = report.brokerSession ?? loadBrokerSession(cwd);
    if (session?.endpoint) {
      await sendBrokerShutdown(session.endpoint);
      report.brokerShutdown = { endpoint: session.endpoint, sent: true };
    }
  } catch (error) {
    report.errors.push(`broker shutdown: ${error.message}`);
  }

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

  const summary = {
    report: path.relative(process.cwd(), args.report),
    codexHome: probeHome,
    availability: report.availability,
    authStatus: report.authStatus,
    brokerTransportUsed: Boolean(report.brokerSession?.endpoint),
    turn: report.turn
      ? {
          status: report.turn.status,
          threadId: report.turn.threadId,
          turnId: report.turn.turnId,
          finalMessage: report.turn.finalMessage,
          turnStatus: report.turn.turnStatus,
          stderr: report.turn.stderr,
          progressEvents: report.turn.progressEvents?.length ?? null,
          error: report.turn.error ?? null
        }
      : null,
    findLatestTaskThread: report.findLatestTaskThread,
    errors: report.errors
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
