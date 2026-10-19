#!/usr/bin/env node
/**
 * Probe `review/start` on Codex 0.163 app-server against a throwaway git repo
 * in /tmp with an uncommitted buggy change.
 *
 * Uses the plugin's exact review request shape:
 *   thread/start (ephemeral, read-only, approvalPolicy never)
 *   review/start { threadId, delivery: "inline", target: { type: "uncommittedChanges" } }
 *
 * Also validates (without a model call) whether review/start tolerates a
 * custom target / unknown outputSchema field, on a bogus thread id.
 *
 * One model call total (the review). Run:
 *   node probes/probe-review.mjs [--report <path>] [--experimental]
 */
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { probeEnv } from "./lib-probe-home.mjs";

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const REVIEW_TIMEOUT_MS = 360_000;

function parseArgs(argv) {
  const args = { report: path.join(PROBE_DIR, "report-review.json"), experimental: false, sandbox: "read-only" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--report") args.report = path.resolve(argv[++i]);
    else if (argv[i] === "--experimental") args.experimental = true;
    else if (argv[i] === "--sandbox") args.sandbox = argv[++i];
  }
  return args;
}

function sh(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeScratchRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-review-repo-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "math.js"),
    [
      "export function sumTo(n) {",
      "  let total = 0;",
      "  for (let i = 1; i <= n; i += 1) {",
      "    total += i;",
      "  }",
      "  return total;",
      "}",
      "",
      "export function average(values) {",
      "  return sumTo(values.length) / values.length;",
      "}",
      ""
    ].join("\n")
  );
  fs.writeFileSync(path.join(repo, "README.md"), "# scratch review repo\n");
  sh("git", ["init", "-q"], repo);
  sh("git", ["config", "user.email", "probe@example.com"], repo);
  sh("git", ["config", "user.name", "Probe"], repo);
  sh("git", ["add", "-A"], repo);
  sh("git", ["commit", "-q", "-m", "base: add math helpers"], repo);

  // Uncommitted, deliberately buggy change: off-by-one in sumTo + average misuse.
  fs.writeFileSync(
    path.join(repo, "src", "math.js"),
    [
      "export function sumTo(n) {",
      "  let total = 0;",
      "  for (let i = 1; i < n; i += 1) {",
      "    total += i;",
      "  }",
      "  return total;",
      "}",
      "",
      "export function average(values) {",
      "  return sumTo(values.length) / values.length;",
      "}",
      ""
    ].join("\n")
  );
  fs.writeFileSync(path.join(repo, "src", "discount.js"), ["export function applyDiscount(x) {", "  return x * 1.15;", "}", ""].join("\n"));
  const diff = sh("git", ["diff", "--", "src/math.js"], repo);
  return { repo, diff, status: sh("git", ["status", "--porcelain"], repo) };
}

class AppServerClient {
  constructor({ cwd }) {
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.lineBuffer = "";
    this.stderr = "";
    this.exitInfo = null;
  }

  async start() {
    this.proc = spawn(CODEX_BIN, ["app-server"], {
      cwd: this.cwd,
      env: probeEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.proc.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
    });
    this.proc.stdout.on("data", (chunk) => this.handleChunk(chunk));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return this;
  }

  send(message) {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = REVIEW_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let idx = this.lineBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.lineBuffer.slice(0, idx).trim();
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      idx = this.lineBuffer.indexOf("\n");
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && message.method) {
        this.notifications.push({ kind: "server-request", message, at: Date.now() });
        this.send({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
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
      if (message.method) {
        const record = { method: message.method, params: message.params, at: Date.now() };
        this.notifications.push(record);
        const waiters = this.waiters.slice();
        this.waiters.length = 0;
        for (const waiter of waiters) {
          if (waiter.predicate(record)) {
            clearTimeout(waiter.timer);
            waiter.resolve(record);
          } else {
            this.waiters.push(waiter);
          }
        }
      }
    }
  }

  waitFor(predicate, timeoutMs, description) {
    const existing = this.notifications.find((record) => record.method !== undefined && predicate(record));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== entry);
        reject(new Error(`timeout waiting for ${description} (${timeoutMs}ms)`));
      }, timeoutMs);
      const entry = { predicate, resolve, timer };
      this.waiters.push(entry);
    });
  }

  async close() {
    try {
      this.proc.stdin.end();
    } catch {}
    await Promise.race([
      new Promise((resolve) => this.proc.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
    if (this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return this.exitInfo;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scratch = makeScratchRepo();
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      codexVersion: spawnSync(CODEX_BIN, ["--version"], { encoding: "utf8" }).stdout.trim(),
      repo: scratch.repo,
      dirtyDiff: scratch.diff,
      gitStatus: scratch.status,
      experimentalApi: args.experimental,
      threadSandbox: args.sandbox
    },
    validationWithoutModel: {},
    review: null
  };

  const client = new AppServerClient({ cwd: scratch.repo });
  await client.start();

  const capabilities = {
    experimentalApi: args.experimental,
    requestAttestation: false,
    optOutNotificationMethods: [
      "item/agentMessage/delta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/textDelta"
    ]
  };
  report.initialize = {
    request: {
      clientInfo: { title: "Codex Plugin", name: "Claude Code", version: "0.0.0-probe" },
      capabilities
    }
  };
  report.initialize.response = await client.request("initialize", report.initialize.request);
  client.notify("initialized", {});
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Param-shape checks on a bogus thread id: no model call, no repo touched.
  const bogus = "00000000-0000-4000-8000-000000000000";
  const validationCases = [
    ["review/start custom target + extra outputSchema", {
      threadId: bogus,
      delivery: "inline",
      target: { type: "custom", instructions: "Focus only on src/math.js" },
      outputSchema: { type: "object", properties: { findings: { type: "array" } } }
    }],
    ["review/start baseBranch target", {
      threadId: bogus,
      target: { type: "baseBranch", branch: "main" }
    }],
    ["review/start commit target", {
      threadId: bogus,
      target: { type: "commit", sha: "deadbeef", title: null }
    }],
    ["review/start detached delivery", {
      threadId: bogus,
      delivery: "detached",
      target: { type: "uncommittedChanges" }
    }]
  ];
  for (const [label, params] of validationCases) {
    try {
      report.validationWithoutModel[label] = { params, response: await client.request("review/start", params) };
    } catch (error) {
      report.validationWithoutModel[label] = { params, error: error.message, rpc: error.rpc ?? null };
    }
  }

  // Real review run with the plugin's shape.
  const threadStartParams = {
    cwd: scratch.repo,
    model: null,
    approvalPolicy: "never",
    sandbox: args.sandbox,
    serviceName: "claude_code_codex_plugin",
    ephemeral: true
  };
  report.threadStart = { request: threadStartParams, response: await client.request("thread/start", threadStartParams) };
  const threadId = report.threadStart.response.thread?.id ?? null;

  const reviewParams = {
    threadId,
    delivery: "inline",
    target: { type: "uncommittedChanges" }
  };
  const startedAt = Date.now();
  report.review = { request: reviewParams, response: null, error: null, completedNotification: null, itemLifecycles: [] };
  try {
    report.review.response = await client.request("review/start", reviewParams);
    const turnId = report.review.response.turn?.id ?? null;
    await client.waitFor(
      (record) => record.method === "turn/completed" && record.params?.turn?.id === turnId,
      REVIEW_TIMEOUT_MS,
      "review turn/completed"
    );
    report.review.durationMs = Date.now() - startedAt;
    report.review.turnId = turnId;
    const completed = client.notifications.find((record) => record.method === "turn/completed" && record.params?.turn?.id === turnId);
    report.review.completedNotification = completed?.params ?? null;
    report.review.itemLifecycles = client.notifications
      .filter((record) => record.method === "item/started" || record.method === "item/completed")
      .map((record) => ({
        method: record.method,
        threadId: record.params?.threadId,
        item: record.params?.item
      }));
    report.review.notificationMethods = [...new Set(client.notifications.filter((r) => r.method).map((r) => r.method))];
    report.review.deprecationNotices = client.notifications
      .filter((record) => record.method === "deprecationNotice")
      .map((record) => record.params);
    report.review.warnings = client.notifications
      .filter((record) => ["warning", "configWarning", "guardianWarning", "error", "model/rerouted", "model/verification"].includes(record.method))
      .map((record) => ({ method: record.method, params: record.params }));
    const reviewItems = client.notifications
      .filter((record) => record.method === "item/completed")
      .map((record) => record.params.item)
      .filter((item) => item.type === "enteredReviewMode" || item.type === "exitedReviewMode");
    report.review.reviewModeItems = reviewItems;
    report.review.agentMessages = client.notifications
      .filter((record) => record.method === "item/completed" && record.params.item.type === "agentMessage")
      .map((record) => ({ phase: record.params.item.phase, text: record.params.item.text }));
    const finalTurnItems = completed?.params?.turn?.items ?? [];
    report.review.finalTurnItemTypes = finalTurnItems.map((item) => item.type);
    report.review.finalTurnEnteredReview = finalTurnItems.filter((item) => item.type === "enteredReviewMode" || item.type === "exitedReviewMode");
  } catch (error) {
    report.review.error = error.message;
    report.review.rpc = error.rpc ?? null;
    report.review.durationMs = Date.now() - startedAt;
    report.review.notificationMethods = [...new Set(client.notifications.filter((r) => r.method).map((r) => r.method))];
    report.review.agentMessages = client.notifications
      .filter((record) => record.method === "item/completed" && record.params.item.type === "agentMessage")
      .map((record) => ({ phase: record.params.item.phase, text: record.params.item.text }));
  }

  report.stderr = client.stderr.trim();
  report.exit = await client.close();

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

  const reviewItem = report.review.reviewModeItems?.find((item) => item.type === "exitedReviewMode");
  const summary = {
    report: path.relative(process.cwd(), args.report),
    codexVersion: report.meta.codexVersion,
    experimentalApi: args.experimental,
    repo: scratch.repo,
    threadId,
    reviewResponse: report.review.response
      ? { turnId: report.review.response.turn?.id, turnStatus: report.review.response.turn?.status, reviewThreadId: report.review.response.reviewThreadId }
      : null,
    reviewError: report.review.error,
    durationMs: report.review.durationMs,
    turnCompletedStatus: report.review.completedNotification?.turn?.status,
    finalTurnItemTypes: report.review.finalTurnItemTypes,
    reviewOutputFromExitedReviewMode: reviewItem?.review ?? null,
    deprecationNotices: report.review.deprecationNotices ?? null,
    warnings: report.review.warnings ?? null,
    reviewModeItemTypes: (report.review.reviewModeItems ?? []).map((item) => item.type),
    agentMessages: report.review.agentMessages,
    notificationMethods: report.review.notificationMethods,
    validationWithoutModel: Object.fromEntries(
      Object.entries(report.validationWithoutModel).map(([label, value]) => [
        label,
        value.error ? { error: value.error, rpcCode: value.rpc?.code } : { responseKeys: Object.keys(value.response ?? {}) }
      ])
    ),
    stderr: report.stderr,
    exit: report.exit
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
