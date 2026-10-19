#!/usr/bin/env node
/**
 * One-model-call probe: does Codex 0.163 honor `turn/start` `outputSchema`
 * (used by the plugin's adversarial-review path) and accept `model`/`effort`
 * overrides?
 *
 * Run: node probes/probe-output-schema.mjs [--report <path>]
 * Output: JSON report with request, response, notifications, final message,
 * parsed JSON (or parse error).
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

  request(method, params, timeoutMs = 240_000) {
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

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
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
    return { code: this.proc.exitCode, signal: this.proc.signal };
  }
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    verdict: { type: "string", enum: ["pass", "fail"] }
  },
  required: ["summary", "verdict"],
  additionalProperties: false
};

async function main() {
  const args = { report: path.join(PROBE_DIR, "report-output-schema.json") };
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--report") args.report = path.resolve(process.argv[++i]);
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-schema-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "# output-schema probe\n");
  const report = { meta: { generatedAt: new Date().toISOString(), cwd }, turn: {} };
  const client = new Client({ cwd });
  await client.start();
  report.initialize = await client.request("initialize", {
    clientInfo: { title: "Codex Plugin", name: "Claude Code", version: "0.0.0-probe" },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false,
      optOutNotificationMethods: [
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
        "item/reasoning/textDelta"
      ]
    }
  });
  client.notify("initialized", {});
  report.threadStart = await client.request("thread/start", {
    cwd,
    model: null,
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "claude_code_codex_plugin",
    ephemeral: true
  });
  const threadId = report.threadStart.thread?.id ?? null;
  report.turn.request = {
    threadId,
    input: [
      {
        type: "text",
        text: "Respond only with the requested JSON object. summary must be the word ok and verdict must be pass.",
        text_elements: []
      }
    ],
    model: null,
    effort: "low",
    outputSchema: OUTPUT_SCHEMA
  };
  const turnStart = await client.request("turn/start", report.turn.request);
  report.turn.response = turnStart;
  const turnId = turnStart.turn?.id ?? null;
  const deadline = Date.now() + 180_000;
  let completed = null;
  while (Date.now() < deadline) {
    completed = client.notifications.find(
      (record) => record.method === "turn/completed" && record.params?.turn?.id === turnId
    );
    if (completed) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const itemCompleted = client.notifications
    .filter((record) => record.method === "item/completed" && record.params?.item?.type === "agentMessage")
    .map((record) => ({ phase: record.params.item.phase, text: record.params.item.text }));
  report.turn.completed = completed?.params ?? null;
  report.turn.agentMessages = itemCompleted;
  const finalText = itemCompleted.at(-1)?.text ?? null;
  report.turn.finalMessage = finalText;
  try {
    report.turn.parsed = finalText ? JSON.parse(finalText) : null;
    report.turn.parseError = null;
  } catch (error) {
    report.turn.parsed = null;
    report.turn.parseError = error.message;
  }
  report.stderr = client.stderr.trim();
  report.exit = await client.close();

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        report: path.relative(process.cwd(), args.report),
        threadId,
        turnStatus: report.turn.completed?.turn?.status ?? null,
        reasoningEffortInResponse: report.turn.completed?.turn?.items?.length ?? null,
        finalMessage: report.turn.finalMessage,
        parsed: report.turn.parsed,
        parseError: report.turn.parseError,
        stderr: report.stderr,
        exit: report.exit
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
