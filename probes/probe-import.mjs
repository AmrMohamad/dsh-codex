#!/usr/bin/env node
/**
 * No-model probe: `externalAgentConfig/import` parameter compatibility on
 * Codex 0.163. The plugin (scripts/lib/codex.mjs, externalAgentSessionMigration)
 * sends MigrationDetails without the `skills` array, which 0.163's
 * MigrationDetails type declares as required.
 *
 * Everything runs against the temporary CODEX_HOME, and the fake Claude session
 * file below is a throwaway /tmp file, so no user data is touched.
 *
 * Run: node probes/probe-import.mjs [--report <path>]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { probeEnv } from "./lib-probe-home.mjs";

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_BIN = process.env.CODEX_BIN || "codex";

class Client {
  constructor({ cwd }) {
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.buffer = "";
    this.stderr = "";
  }

  async start() {
    this.proc = spawn(CODEX_BIN, ["app-server"], { cwd: this.cwd, env: probeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.proc.stdout.on("data", (chunk) => this.handleChunk(chunk));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return this;
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  handleChunk(chunk) {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf("\n");
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && message.method) {
        this.proc.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported" } })}\n`);
        continue;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message ?? "request failed");
          error.rpc = message.error;
          pending.reject(error);
        } else {
          pending.resolve(message.result ?? {});
        }
        continue;
      }
      if (message.method) this.notifications.push({ method: message.method, params: message.params });
    }
  }

  async close() {
    try {
      this.proc.stdin.end();
    } catch {}
    await Promise.race([
      new Promise((resolve) => this.proc.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
    if (this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exactly the shape built by scripts/lib/codex.mjs externalAgentSessionMigration() */
function pluginMigrationPayload(sessionPath, repo) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sessionPath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sessionPath, cwd: repo, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function main() {
  const args = { report: path.join(PROBE_DIR, "report-import.json") };
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--report") args.report = path.resolve(process.argv[++i]);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-import-"));
  const repo = path.join(work, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const sessionPath = path.join(work, "fake-claude-session.jsonl");
  fs.writeFileSync(sessionPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const report = {
    meta: { generatedAt: new Date().toISOString(), sessionPath, repo },
    initialize: null,
    cases: {}
  };

  const client = new Client({ cwd: work });
  await client.start();
  report.initialize = await client.request("initialize", {
    clientInfo: { title: "Codex Plugin", name: "Claude Code", version: "0.0.0-probe" },
    capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: [] }
  });
  client.proc.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

  const cases = [
    ["plugin payload (details without skills)", pluginMigrationPayload(sessionPath, repo)],
    [
      "payload with skills: [] added",
      (() => {
        const payload = pluginMigrationPayload(sessionPath, repo);
        payload.migrationItems[0].details.skills = [];
        return payload;
      })()
    ],
    ["empty migrationItems", { migrationItems: [] }]
  ];
  for (const [label, params] of cases) {
    const before = client.notifications.length;
    const entry = { request: params };
    try {
      entry.response = await client.request("externalAgentConfig/import", params);
    } catch (error) {
      entry.error = error.message;
      entry.rpc = error.rpc ?? null;
    }
    await sleep(2500);
    entry.notifications = client.notifications.slice(before).map((record) => ({ method: record.method, params: record.params }));
    report.cases[label] = entry;
  }

  report.stderr = client.stderr.trim();
  await client.close();
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

  const summary = {
    report: path.relative(process.cwd(), args.report),
    initialize: report.initialize,
    cases: Object.fromEntries(
      Object.entries(report.cases).map(([label, value]) => [
        label,
        {
          response: value.response ?? null,
          error: value.error ?? null,
          rpcCode: value.rpc?.code ?? null,
          notifications: value.notifications.map((record) => ({
            method: record.method,
            params: record.params
          }))
        }
      ])
    ),
    stderr: report.stderr
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
