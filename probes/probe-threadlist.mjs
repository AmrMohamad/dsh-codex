#!/usr/bin/env node
/**
 * No-model probe: thread persistence/listing semantics and review/start
 * deprecation notices on Codex 0.163.
 *
 * Answers, empirically:
 *  - What `Thread.source` do app-server-created threads get?
 *  - Does `thread/list` with the plugin's `sourceKinds: ["appServer"]` +
 *    `searchTerm` find them?
 *  - Does `thread/list` find persistent (ephemeral:false) named threads at all?
 *  - Does `thread/resume` work on a persistent, never-turned thread?
 *  - Does `review/start` emit deprecationNotice for inline vs detached?
 *
 * Run: node probes/probe-threadlist.mjs [--report <path>]
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { probeEnv } from "./lib-probe-home.mjs";

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_BIN = process.env.CODEX_BIN || "codex";

function parseArgs(argv) {
  const args = { report: path.join(PROBE_DIR, "report-threadlist.json") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--report") args.report = path.resolve(argv[++i]);
  }
  return args;
}

class AppServerClient {
  constructor({ cwd }) {
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
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

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
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
      if (message.method) this.notifications.push({ method: message.method, params: message.params, at: Date.now() });
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
    return this.exitInfo;
  }
}

function summarizeThread(thread) {
  if (!thread) return null;
  return {
    id: thread.id,
    name: thread.name ?? null,
    ephemeral: thread.ephemeral,
    source: thread.source,
    threadSource: thread.threadSource ?? null,
    originator: thread.originator ?? null,
    cwd: thread.cwd,
    historyMode: thread.historyMode ?? null,
    status: thread.status?.type ?? thread.status ?? null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-threadlist-"));
  const scratchReal = fs.realpathSync(scratch);
  fs.writeFileSync(path.join(scratch, "README.md"), "# thread-list probe\n");
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      codexVersion: require_version(),
      probeCwd: scratch
    },
    initialize: null,
    threads: [],
    lists: {},
    resumePersistent: null,
    reviewDeprecation: null,
    stderr: "",
    exit: null
  };

  const client = new AppServerClient({ cwd: scratch });
  await client.start();
  report.initialize = {
    request: {
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
    }
  };
  report.initialize.request = report.initialize.request;
  report.initialize.response = await client.request("initialize", report.initialize.request);
  client.notify("initialized", {});
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Create threads with different source hints to see what thread/list filters match.
  const variants = [
    { label: "ephemeral-default", params: { ephemeral: true } },
    { label: "persistent-default", params: { ephemeral: false } },
    { label: "persistent-threadSource-appServer", params: { ephemeral: false, threadSource: "appServer" } }
  ];
  for (const variant of variants) {
    const name = `Codex Companion Task: ${variant.label}`;
    const request = {
      cwd: scratch,
      model: null,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "claude_code_codex_plugin",
      ...variant.params
    };
    const response = await client.request("thread/start", request);
    const threadId = response.thread?.id ?? null;
    let nameSet = null;
    try {
      nameSet = await client.request("thread/name/set", { threadId, name });
    } catch (error) {
      nameSet = { error: error.message, rpc: error.rpc ?? null };
    }
    report.threads.push({
      label: variant.label,
      request,
      responseThread: summarizeThread(response.thread),
      nameSet,
      threadId
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  await new Promise((resolve) => setTimeout(resolve, 600));
  const listCases = {
    "plugin findLatestTaskThread params": {
      cwd: scratch,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: "Codex Companion Task"
    },
    "same but no sourceKinds": { cwd: scratch, limit: 20, sortKey: "updated_at", searchTerm: "Codex Companion Task" },
    "sourceKinds appServer only": { cwd: scratch, limit: 20, sourceKinds: ["appServer"] },
    "sourceKinds vscode only": { cwd: scratch, limit: 20, sourceKinds: ["vscode"] },
    "cwd only": { cwd: scratch, limit: 20 },
    "plugin params with realpath cwd": {
      cwd: scratchReal,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: "Codex Companion Task"
    },
    "realpath cwd, no sourceKinds": {
      cwd: scratchReal,
      limit: 20,
      sortKey: "updated_at",
      searchTerm: "Codex Companion Task"
    },
    "realpath cwd, vscode sourceKinds": {
      cwd: scratchReal,
      limit: 20,
      sourceKinds: ["vscode"]
    },
    "realpath cwd, useStateDbOnly": {
      cwd: scratchReal,
      limit: 20,
      useStateDbOnly: true
    },
    "no cwd filter": { limit: 20 }
  };
  for (const [label, params] of Object.entries(listCases)) {
    try {
      const response = await client.request("thread/list", params);
      report.lists[label] = {
        params,
        dataLength: response.data?.length ?? null,
        responseKeys: Object.keys(response),
        threads: (response.data ?? []).map((thread) => ({
          ...summarizeThread(thread),
          name: thread.name ?? null
        }))
      };
    } catch (error) {
      report.lists[label] = { params, error: error.message, rpc: error.rpc ?? null };
    }
  }

  // thread/list only returns threads that have a persisted rollout; give the
  // persistent-default thread one tiny turn, then list again.
  const persistentEntry = report.threads.find((entry) => entry.label === "persistent-default");
  report.persistTurn = { request: null, response: null, completed: null, error: null };
  if (persistentEntry?.threadId) {
    try {
      report.persistTurn.request = {
        threadId: persistentEntry.threadId,
        input: [{ type: "text", text: "Reply with exactly: OK", text_elements: [] }],
        model: null,
        effort: null,
        outputSchema: null
      };
      report.persistTurn.response = await client.request("turn/start", report.persistTurn.request);
      const turnId = report.persistTurn.response.turn?.id ?? null;
      await Promise.race([
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 120_000;
          const poll = () => {
            const completed = client.notifications.find(
              (record) => record.method === "turn/completed" && record.params?.turn?.id === turnId
            );
            if (completed) return resolve(completed);
            if (Date.now() > deadline) return reject(new Error("timeout waiting for turn/completed"));
            setTimeout(poll, 100);
          };
          poll();
        })
      ]).then((completed) => {
        report.persistTurn.completed = completed.params;
      });
    } catch (error) {
      report.persistTurn.error = error.message;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const listCasesAfterTurn = {
    "plugin params with realpath cwd after turn": {
      cwd: scratchReal,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: "Codex Companion Task"
    },
    "realpath cwd, searchTerm only after turn": {
      cwd: scratchReal,
      limit: 20,
      sortKey: "updated_at",
      searchTerm: "Codex Companion Task"
    },
    "realpath cwd, vscode sourceKinds after turn": {
      cwd: scratchReal,
      limit: 20,
      sourceKinds: ["vscode"]
    },
    "realpath cwd only after turn": { cwd: scratchReal, limit: 20 },
    "no cwd filter after turn": { limit: 20 }
  };
  report.listsAfterTurn = {};
  for (const [label, params] of Object.entries(listCasesAfterTurn)) {
    try {
      const response = await client.request("thread/list", params);
      report.listsAfterTurn[label] = {
        params,
        dataLength: response.data?.length ?? null,
        threads: (response.data ?? []).map((thread) => summarizeThread(thread))
      };
    } catch (error) {
      report.listsAfterTurn[label] = { params, error: error.message, rpc: error.rpc ?? null };
    }
  }

  // Resume the persistent (ephemeral:false) non-appServer thread the plugin created.
  const persistent = report.threads.find((entry) => entry.label === "persistent-default");
  if (persistent?.threadId) {
    try {
      const response = await client.request("thread/resume", {
        threadId: persistent.threadId,
        cwd: scratch,
        model: null,
        approvalPolicy: "never",
        sandbox: "read-only"
      });
      report.resumePersistent = {
        request: { threadId: persistent.threadId, cwd: scratch },
        responseKeys: Object.keys(response),
        thread: summarizeThread(response.thread),
        response
      };
    } catch (error) {
      report.resumePersistent = { threadId: persistent.threadId, error: error.message, rpc: error.rpc ?? null };
    }
  }

  // review/start deprecation-notice check, inline first then detached, bogus thread
  // id => fails at thread lookup without starting a review.
  const bogus = "00000000-0000-4000-8000-000000000000";
  const reviewNotices = [];
  for (const delivery of ["inline", "detached"]) {
    const before = client.notifications.length;
    let error = null;
    try {
      await client.request("review/start", { threadId: bogus, delivery, target: { type: "uncommittedChanges" } });
    } catch (caught) {
      error = caught.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    reviewNotices.push({
      delivery,
      error,
      newNotifications: client.notifications.slice(before).map((record) => ({ method: record.method, params: record.params }))
    });
  }
  report.reviewDeprecation = reviewNotices;

  report.threadDelete = [];
  for (const entry of report.threads) {
    if (!entry.threadId) continue;
    try {
      report.threadDelete.push({ threadId: entry.threadId, response: await client.request("thread/delete", { threadId: entry.threadId }) });
    } catch (error) {
      report.threadDelete.push({ threadId: entry.threadId, error: error.message });
    }
  }

  report.stderr = client.stderr.trim();
  report.exit = await client.close();
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    `${JSON.stringify(
      {
        report: path.relative(process.cwd(), args.report),
        codexVersion: report.meta.codexVersion,
        threads: report.threads.map((entry) => ({
          label: entry.label,
          responseSource: entry.responseThread?.source,
          originator: entry.responseThread?.originator,
          threadSource: entry.responseThread?.threadSource,
          ephemeral: entry.responseThread?.ephemeral,
          nameSet: entry.nameSet
        })),
        lists: Object.fromEntries(
          Object.entries(report.lists).map(([label, value]) => [
            label,
            value.error
              ? { error: value.error }
              : { dataLength: value.dataLength, names: value.threads.map((thread) => thread.name), sources: value.threads.map((thread) => thread.source) }
          ])
        ),
        persistTurn: {
          turnStatus: report.persistTurn?.completed?.turn?.status ?? null,
          error: report.persistTurn?.error ?? null
        },
        listsAfterTurn: Object.fromEntries(
          Object.entries(report.listsAfterTurn ?? {}).map(([label, value]) => [
            label,
            value.error
              ? { error: value.error }
              : {
                  dataLength: value.dataLength,
                  names: value.threads.map((thread) => thread.name),
                  sources: value.threads.map((thread) => thread.source)
                }
          ])
        ),
        resumePersistent: report.resumePersistent?.error ?? {
          responseKeys: report.resumePersistent?.responseKeys,
          thread: report.resumePersistent?.thread
        },
        reviewDeprecation: report.reviewDeprecation.map((entry) => ({
          delivery: entry.delivery,
          error: entry.error,
          notices: entry.newNotifications.map((record) => record.method),
          deprecationParams: entry.newNotifications.filter((record) => record.method === "deprecationNotice").map((record) => record.params)
        })),
        stderr: report.stderr,
        exit: report.exit
      },
      null,
      2
    )}\n`
  );
}

function require_version() {
  return spawnSync(CODEX_BIN, ["--version"], { encoding: "utf8" }).stdout.trim();
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
