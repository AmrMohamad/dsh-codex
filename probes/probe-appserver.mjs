#!/usr/bin/env node
/**
 * Probe the installed Codex app-server (0.163.x) over stdio using the SAME
 * JSON-RPC dialect the plugin sends (no jsonrpc field, line-delimited JSON).
 *
 * No dependencies. Makes exactly two (cheap) model calls:
 *   1. thread/start + turn/start "Reply with exactly: OK"
 *   2. thread/start + turn/start long-ish prompt, then turn/interrupt
 * Everything else (handshake, thread/resume, thread/list, auth, param
 * validation) is local/no-model.
 *
 * Usage:
 *   node probes/probe-appserver.mjs [--report <path>] [--cwd <dir>]
 *
 * Writes a full JSON report (captured payloads) and prints a compact summary.
 */
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { probeEnv } from "./lib-probe-home.mjs";

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const REQUEST_TIMEOUT_MS = 240_000;
const TURN_TIMEOUT_MS = 240_000;

function parseArgs(argv) {
  const args = { report: path.join(PROBE_DIR, "report-appserver.json"), cwd: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--report") args.report = path.resolve(argv[++i]);
    else if (argv[i] === "--cwd") args.cwd = path.resolve(argv[++i]);
  }
  return args;
}

function mkScratchCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-appserver-"));
  fs.writeFileSync(path.join(dir, "README.md"), "# app-server probe\n\nScratch directory; nothing here matters.\n");
  return dir;
}

class AppServerClient {
  constructor({ cwd, args = [], label = "stdio" }) {
    this.cwd = cwd;
    this.args = args;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.lineBuffer = "";
    this.stderr = "";
    this.closed = false;
    this.exitInfo = null;
  }

  async start() {
    this.proc = spawn(CODEX_BIN, ["app-server", ...this.args], {
      cwd: this.cwd,
      env: probeEnv({ copyConfig: process.env.CODEX_PROBE_COPY_CONFIG === "1" }),
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

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
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
      } catch (error) {
        this.notifications.push({ kind: "parse-error", line, error: String(error) });
        continue;
      }
      if (message.id !== undefined && message.method) {
        // Server -> client request (approvals etc). The plugin answers -32601.
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
          const error = new Error(message.error.message ?? `${pending.method} failed`);
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
        const pendingWaiters = this.waiters.slice();
        this.waiters.length = 0;
        for (const waiter of pendingWaiters) {
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

  waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS, description = "notification") {
    const existing = this.notifications.find(
      (record) => record.method !== undefined && predicate(record)
    );
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
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {}
    const exited = await Promise.race([
      new Promise((resolve) => this.proc.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
    if (this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return exited;
  }
}

// --- request payloads: exactly what the plugin sends (see scripts/lib/codex.mjs) ---
const PLUGIN_INITIALIZE = {
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
};

function pluginThreadStartParams(cwd, overrides = {}) {
  return {
    cwd,
    model: null,
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "claude_code_codex_plugin",
    ephemeral: true,
    ...overrides
  };
}

function pluginResumeParams(threadId, cwd) {
  return { threadId, cwd, model: null, approvalPolicy: "never", sandbox: "read-only" };
}

function turnInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

function extractTurnResult(notifications, threadId, turnId) {
  const scoped = notifications.filter(
    (record) =>
      record.method &&
      (record.params?.threadId === undefined || record.params.threadId === threadId) &&
      (record.params?.turnId === undefined || record.params.turnId === turnId)
  );
  const itemMethods = scoped.filter((r) => r.method === "item/completed").map((r) => r.params.item);
  const agentMessages = itemMethods.filter((item) => item.type === "agentMessage");
  const finalMessages = agentMessages.filter((item) => item.phase === "final_answer");
  const completed = scoped.find((r) => r.method === "turn/completed");
  return {
    finalAssistantMessage: (finalMessages.at(-1) ?? agentMessages.at(-1))?.text ?? null,
    finalPhase: (finalMessages.at(-1) ?? agentMessages.at(-1))?.phase ?? null,
    allAgentMessages: agentMessages.map((item) => ({ phase: item.phase, text: item.text })),
    turn: completed?.params?.turn ?? null,
    methods: [...new Set(scoped.map((r) => r.method))],
    itemTypes: [...new Set(itemMethods.map((item) => item.type))]
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd ?? mkScratchCwd();
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      codexBin: CODEX_BIN,
      codexVersion: execSync(`${CODEX_BIN} --version 2>&1 | tail -1`, { encoding: "utf8" }).trim(),
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      probeCodexHome: process.env.CODEX_PROBE_HOME ?? `${os.tmpdir()}/codex-probe-home`,
      probeCwd: cwd
    },
    pluginRequests: {
      initialize: PLUGIN_INITIALIZE,
      threadStart: pluginThreadStartParams(cwd),
      resume: "<filled per thread>",
      threadNameSet: null,
      turnStart: null
    }
  };

  const client = new AppServerClient({ cwd });
  await client.start();
  const startedAt = Date.now();

  // 1) Handshake (plugin: initialize then initialized notification)
  report.handshake = { request: PLUGIN_INITIALIZE };
  report.handshake.response = await client.request("initialize", PLUGIN_INITIALIZE);
  client.notify("initialized", {});
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 2) thread/start with plugin params
  report.pluginRequests.threadStart = pluginThreadStartParams(cwd);
  const threadStart = await client.request("thread/start", report.pluginRequests.threadStart);
  report.threadStart = { response: threadStart };
  const threadId = threadStart.thread?.id ?? null;

  // 3) thread/name/set on the EPHEMERAL thread (0.163 rejects metadata updates).
  report.pluginRequests.threadNameSet = { threadId, name: "Codex Companion Task: probe" };
  try {
    report.threadNameSet = {
      response: await client.request("thread/name/set", report.pluginRequests.threadNameSet)
    };
  } catch (error) {
    report.threadNameSet = { error: error.message, rpc: error.rpc ?? null };
  }
  report.threadNameUpdatedNotification = client.notifications.filter((r) => r.method === "thread/name/updated");

  // 3b) persistent thread (plugin task threads use ephemeral:false) + name/set
  const persistentStartParams = pluginThreadStartParams(cwd, { ephemeral: false });
  const persistentStart = await client.request("thread/start", persistentStartParams);
  const persistentThreadId = persistentStart.thread?.id ?? null;
  report.persistentThread = {
    threadStartParams: persistentStartParams,
    threadStartResponse: persistentStart,
    nameSet: null
  };
  const persistentName = "Codex Companion Task: persistent probe";
  try {
    report.persistentThread.nameSet = {
      request: { threadId: persistentThreadId, name: persistentName },
      response: await client.request("thread/name/set", { threadId: persistentThreadId, name: persistentName })
    };
  } catch (error) {
    report.persistentThread.nameSet = { request: { threadId: persistentThreadId, name: persistentName }, error: error.message, rpc: error.rpc ?? null };
  }

  // 4) turn/start with plugin's minimal turn params ("Reply with exactly: OK")
  report.pluginRequests.turnStart = {
    threadId,
    input: turnInput("Reply with exactly: OK"),
    model: null,
    effort: null,
    outputSchema: null
  };
  const turnStart = await client.request("turn/start", report.pluginRequests.turnStart);
  report.turnStart = { response: turnStart };
  const turnId = turnStart.turn?.id ?? null;
  let turnCompleted = null;
  try {
    turnCompleted = await client.waitFor(
      (r) => r.method === "turn/completed" && r.params?.turn?.id === turnId,
      TURN_TIMEOUT_MS,
      "turn/completed for OK turn"
    );
  } catch (error) {
    report.turnStart.error = String(error);
  }
  report.turnStart.notifications = client.notifications.filter((r) => r.method);
  report.turnStart.result = extractTurnResult(client.notifications, threadId, turnId);
  report.turnStart.completedNotification = turnCompleted?.params ?? null;

  // 5) thread/resume on the same (ephemeral) thread, exactly like the plugin
  report.pluginRequests.resume = pluginResumeParams(threadId, cwd);
  try {
    report.threadResume = { response: await client.request("thread/resume", report.pluginRequests.resume) };
  } catch (error) {
    report.threadResume = { error: error.message, rpc: error.rpc ?? null };
  }

  // 6) thread/list exactly like the plugin (findLatestTaskThread)
  const threadListParams = {
    cwd,
    limit: 20,
    sortKey: "updated_at",
    sourceKinds: ["appServer"],
    searchTerm: "Codex Companion Task"
  };
  try {
    const threadList = await client.request("thread/list", threadListParams);
    report.threadList = {
      request: threadListParams,
      responseSummary: {
        dataLength: Array.isArray(threadList.data) ? threadList.data.length : null,
        keys: Object.keys(threadList),
        firstThread: threadList.data?.[0]
          ? {
              id: threadList.data[0].id,
              name: threadList.data[0].name,
              ephemeral: threadList.data[0].ephemeral,
              source: threadList.data[0].source,
              cwd: threadList.data[0].cwd
            }
          : null,
        containsEphemeralProbeThread: Array.isArray(threadList.data)
          ? threadList.data.some((thread) => thread.id === threadId)
          : null,
        containsPersistentProbeThread: Array.isArray(threadList.data)
          ? threadList.data.some((thread) => thread.id === persistentThreadId)
          : null
      }
    };
  } catch (error) {
    report.threadList = { request: threadListParams, error: error.message, rpc: error.rpc ?? null };
  }

  // 6b) cleanup the persistent probe thread (state lives in the temp CODEX_HOME)
  try {
    report.threadDelete = {
      response: await client.request("thread/delete", { threadId: persistentThreadId })
    };
  } catch (error) {
    report.threadDelete = { error: error.message, rpc: error.rpc ?? null };
  }

  // 7) interrupt flow: second thread, long-ish prompt, interrupt once running
  const interruptThreadStart = await client.request("thread/start", pluginThreadStartParams(cwd));
  const interruptThreadId = interruptThreadStart.thread?.id ?? null;
  const interruptTurnStart = await client.request("turn/start", {
    threadId: interruptThreadId,
    input: turnInput("Count slowly from 1 to 300, one number per line. Do not stop early."),
    model: null,
    effort: null,
    outputSchema: null
  });
  const interruptTurnId = interruptTurnStart.turn?.id ?? null;
  report.interrupt = {
    threadStart: interruptThreadStart,
    turnStart: interruptTurnStart,
    interruptResponse: null,
    completedNotification: null,
    result: null
  };
  try {
    await client.waitFor(
      (r) => r.method === "turn/started" && r.params?.turn?.id === interruptTurnId,
      30_000,
      "turn/started for interrupt turn"
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    report.interrupt.interruptResponse = await client.request("turn/interrupt", {
      threadId: interruptThreadId,
      turnId: interruptTurnId
    });
    const interruptedCompleted = await client.waitFor(
      (r) => r.method === "turn/completed" && r.params?.turn?.id === interruptTurnId,
      120_000,
      "turn/completed for interrupted turn"
    );
    report.interrupt.completedNotification = interruptedCompleted.params;
    report.interrupt.result = extractTurnResult(client.notifications, interruptThreadId, interruptTurnId);
  } catch (error) {
    report.interrupt.error = String(error);
    report.interrupt.result = extractTurnResult(client.notifications, interruptThreadId, interruptTurnId);
  }

  // 8) auth + account + config + rate limits
  report.auth = {};
  try {
    report.auth.getAuthStatus = await client.request("getAuthStatus", { includeToken: false, refreshToken: false });
  } catch (error) {
    report.auth.getAuthStatus = { error: error.message, rpc: error.rpc ?? null };
  }
  try {
    report.auth.accountRead = await client.request("account/read", { refreshToken: false });
  } catch (error) {
    report.auth.accountRead = { error: error.message, rpc: error.rpc ?? null };
  }
  try {
    report.auth.configRead = await client.request("config/read", { includeLayers: false, cwd });
  } catch (error) {
    report.auth.configRead = { error: error.message, rpc: error.rpc ?? null };
  }
  try {
    report.auth.rateLimits = await client.request("account/rateLimits/read", {});
  } catch (error) {
    report.auth.rateLimits = { error: error.message, rpc: error.rpc ?? null };
  }

  // 9) parameter-shape validation with NO model calls (bogus uuid: fails at thread load)
  const bogusThreadId = "00000000-0000-4000-8000-000000000000";
  report.paramValidation = {};
  const validationCases = [
    ["review/start custom target + unknown outputSchema field", "review/start", {
      threadId: bogusThreadId,
      delivery: "inline",
      target: { type: "custom", instructions: "Focus only on src/math.js" },
      outputSchema: { type: "object", properties: { summary: { type: "string" } } }
    }],
    ["review/start uncommittedChanges target", "review/start", {
      threadId: bogusThreadId,
      delivery: "inline",
      target: { type: "uncommittedChanges" }
    }],
    ["review/start invalid target enum", "review/start", {
      threadId: bogusThreadId,
      delivery: "inline",
      target: { type: "notARealTarget" }
    }],
    ["review/start detached delivery", "review/start", {
      threadId: bogusThreadId,
      delivery: "detached",
      target: { type: "uncommittedChanges" }
    }],
    ["turn/start with turn-level sandboxPolicy + outputSchema", "turn/start", {
      threadId: bogusThreadId,
      input: turnInput("hi"),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: null,
      effort: "low",
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
    }],
    ["turn/start with old string sandbox field", "turn/start", {
      threadId: bogusThreadId,
      input: turnInput("hi"),
      sandbox: "read-only"
    }],
    ["thread/start with modelReasoningEffort (old REST-ish name)", "thread/start", {
      cwd, modelReasoningEffort: "low"
    }],
    ["thread/start with developerInstructions + config", "thread/start", {
      cwd, developerInstructions: "Be terse.", config: { model_reasoning_effort: "low" }
    }]
  ];
  for (const [label, method, params] of validationCases) {
    try {
      report.paramValidation[label] = { method, params, response: await client.request(method, params) };
    } catch (error) {
      report.paramValidation[label] = { method, params, error: error.message, rpc: error.rpc ?? null };
    }
  }

  report.stderr = client.stderr.trim();
  report.transport = client.label;
  report.durationMs = Date.now() - startedAt;
  await client.close();
  report.exit = client.exitInfo;

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

  const summary = {
    report: path.relative(process.cwd(), args.report),
    codexVersion: report.meta.codexVersion,
    handshakeResponse: report.handshake.response,
    threadStart: {
      responseKeys: Object.keys(report.threadStart.response),
      thread: {
        id: report.threadStart.response.thread?.id,
        ephemeral: report.threadStart.response.thread?.ephemeral,
        source: report.threadStart.response.thread?.source,
        cwd: report.threadStart.response.thread?.cwd
      },
      model: report.threadStart.response.model,
      approvalPolicy: report.threadStart.response.approvalPolicy,
      sandbox: report.threadStart.response.sandbox,
      reasoningEffort: report.threadStart.response.reasoningEffort
    },
    turnStart: {
      responseTurnStatus: report.turnStart.response?.turn?.status,
      result: report.turnStart.result,
      completedNotification: report.turnStart.completedNotification,
      notificationMethods: report.turnStart.result?.methods
    },
    ephemeralThreadNameSet: report.threadNameSet,
    persistentThread: {
      threadId: report.persistentThread.threadStartResponse.thread?.id,
      ephemeral: report.persistentThread.threadStartResponse.thread?.ephemeral,
      nameSet: report.persistentThread.nameSet
    },
    resume: report.threadResume.error
      ? { error: report.threadResume.error, rpc: report.threadResume.rpc }
      : { responseKeys: Object.keys(report.threadResume.response), threadStatus: report.threadResume.response.thread?.status },
    threadList: report.threadList.responseSummary ?? report.threadList,
    interrupt: {
      interruptResponse: report.interrupt.interruptResponse,
      completedStatus: report.interrupt.completedNotification?.turn?.status,
      turn: report.interrupt.completedNotification?.turn ?? null,
      notificationMethods: report.interrupt.result?.methods
    },
    auth: {
      getAuthStatus: report.auth.getAuthStatus,
      accountRead: report.auth.accountRead,
      configRead: {
        model: report.auth.configRead?.config?.model,
        review_model: report.auth.configRead?.config?.review_model,
        model_provider: report.auth.configRead?.config?.model_provider,
        model_reasoning_effort: report.auth.configRead?.config?.model_reasoning_effort,
        service_tier: report.auth.configRead?.config?.service_tier,
        keys: report.auth.configRead?.config ? Object.keys(report.auth.configRead.config) : null
      },
      rateLimits: report.auth.rateLimits
    },
    paramValidation: Object.fromEntries(
      Object.entries(report.paramValidation).map(([label, value]) => [
        label,
        value.error ? { error: value.error, rpcCode: value.rpc?.code, data: value.rpc?.data } : { responseKeys: Object.keys(value.response ?? {}) }
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
