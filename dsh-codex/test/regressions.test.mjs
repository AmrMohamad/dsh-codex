import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { parseCommandInput } from "../index.js";
import { createOperations } from "../lib/operations.js";
import { taskArgv } from "../lib/argv.js";
import {
  findStoredCodexJob,
  isTerminalStoredJob,
  listStoredCodexJobs,
  renderStoredCodexJob
} from "../lib/job-store.js";
import { expandHome, resolveCodex, resolveDataDir } from "../lib/resolve.js";
import { createRunner } from "../lib/runtime.js";
import { createFakeJobs, createFakeRunner } from "./fakes.mjs";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStoredJob(dataDir, workspace, job) {
  const jobsDir = path.join(dataDir, "state", workspace, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2), "utf8");
}

function opEnv(options = {}) {
  const jobs = Object.prototype.hasOwnProperty.call(options, "jobs") ? options.jobs : createFakeJobs();
  const dataDir = options.dataDir ?? tmpDir("dsh-codex-reg-data-");
  const runner = options.runner ?? createFakeRunner(() => ({ stdout: "OK\n" }), { dataDir });
  runner.dataDir = () => dataDir;
  const cwd = options.cwd ?? tmpDir("dsh-codex-reg-cwd-");
  const approvalCalls = [];
  const approvalService =
    options.approval === null
      ? undefined
      : {
          async request(request) {
            approvalCalls.push(request);
            return options.approvalOutcome ?? "allowed-once";
          }
        };
  const ctx = {
    workingDirectory: { get: () => cwd, defaultDirectory: cwd, ensure: async () => cwd },
    get(name) {
      if (name === "jobs") {
        return jobs;
      }
      if (name === "approval") {
        return approvalService;
      }
      return undefined;
    }
  };
  const operations = createOperations({ ctx, runner, config: options.config ?? {} });
  const exec = {
    agent: { id: "session-1", session: { id: "session-1" } },
    callId: "call-1",
    rootCallId: "call-1",
    signal: new AbortController().signal
  };
  return { jobs, dataDir, runner, cwd, operations, exec, approvalCalls };
}

/* ------------------------------ command parser ------------------------------ */

test("command parser treats flags before text, and text after the first token", () => {
  const parsed = parseCommandInput("--write --model gpt fix the --write bug", {
    valueFlags: ["model"],
    boolFlags: ["write"]
  });
  assert.deepEqual(parsed.flags, { write: true, model: "gpt" });
  // After the first positional, the suffix is literal task text (not flags).
  assert.deepEqual(parsed.positionals, ["fix the --write bug"]);
});

test("command parser honors -- as a literal-text separator", () => {
  const parsed = parseCommandInput("-- Explain the --write flag", {
    boolFlags: ["write"]
  });
  assert.deepEqual(parsed.flags, {});
  assert.deepEqual(parsed.positionals, ["Explain the --write flag"]);
});

test("command parser rejects unknown options and missing values", () => {
  assert.throws(
    () => parseCommandInput("--bse main", { valueFlags: ["base"] }),
    /Unknown option --bse/
  );
  assert.throws(
    () => parseCommandInput("--base", { valueFlags: ["base"] }),
    /needs a value/
  );
  // The two crash-prone commands call the parser with no options object.
  assert.deepEqual(parseCommandInput("job-1"), { flags: {}, positionals: ["job-1"] });
});

/* ------------------------------- argv contracts ------------------------------ */

test("promptless resume never emits a literal null --prompt-file", () => {
  const argv = taskArgv({ cwd: "/repo", resumeLast: true, jobId: "j1" });
  assert.equal(argv.includes("--prompt-file"), false);
  assert.ok(argv.includes("--resume-last"));
  assert.deepEqual(argv.slice(-2), ["--job-id", "j1"]);

  const withPrompt = taskArgv({ cwd: "/repo", promptFile: "/tmp/p.txt", write: true });
  assert.deepEqual(withPrompt.slice(0, 4), ["task", "--cwd", "/repo", "--prompt-file"]);
});

/* --------------------------- workspace / data dir --------------------------- */

test("data directory is profile-independent, env-overridable and tilde-expanded", () => {
  const saved = { ...process.env };
  try {
    process.env.DSH_HOME = "/tmp/dsh-home-x";
    delete process.env.DSH_PROFILE;
    delete process.env.CODEX_PLUGIN_DATA_DIR;
    assert.equal(resolveDataDir({}), "/tmp/dsh-home-x/codex-plugin-data");
    process.env.CODEX_PLUGIN_DATA_DIR = "~/custom-codex-data";
    assert.equal(resolveDataDir({}), path.join(os.homedir(), "custom-codex-data"));
    assert.equal(resolveDataDir({ dataDir: "~/explicit" }), path.join(os.homedir(), "explicit"));
  } finally {
    process.env = saved;
  }
});

test("CODEX_PLUGIN_CODEX_PATH is honored as a documented override", () => {
  const candidate = "/opt/homebrew/bin/codex";
  if (!fs.existsSync(candidate)) {
    return;
  }
  const saved = { ...process.env };
  try {
    process.env.CODEX_PLUGIN_CODEX_PATH = candidate;
    assert.equal(resolveCodex({}).command, candidate);
  } finally {
    process.env = saved;
  }
});

test("expandHome expands only a leading ~", () => {
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("~/x"), path.join(os.homedir(), "x"));
  assert.equal(expandHome("/abs/~x"), "/abs/~x");
});

/* ------------------------- stored record rendering ------------------------- */

test("stored records render terminal status, errors and object results", () => {
  const cancelled = {
    id: "codex-c1",
    status: "cancelled",
    summary: "Codex task: investigate",
    rendered: "Some stale prompt text\n",
    threadId: "thread-c1"
  };
  const text = renderStoredCodexJob(cancelled);
  assert.match(text, /Status: cancelled/);
  assert.match(text, /codex resume thread-c1/);
  assert.doesNotMatch(text, /Some stale prompt text/);

  const failed = {
    id: "codex-f1",
    status: "failed",
    summary: "Codex review",
    errorMessage: "app-server died",
    result: { ok: false, detail: "boom" }
  };
  const failedText = renderStoredCodexJob(failed);
  assert.match(failedText, /app-server died/);
  assert.doesNotMatch(failedText, /\[object Object\]/);

  const completedObject = { id: "codex-ok", status: "completed", result: { verdict: "clean" } };
  assert.match(renderStoredCodexJob(completedObject), /"verdict": "clean"/);

  const running = { id: "codex-run", status: "running", rendered: "partial output" };
  assert.doesNotMatch(renderStoredCodexJob(running), /partial output/);
  assert.equal(isTerminalStoredJob(running), false);
});

test("cross-workspace job listing filters by session and terminal status", () => {
  const dataDir = tmpDir("dsh-codex-list-");
  writeStoredJob(dataDir, "ws-a", {
    id: "codex-a",
    sessionId: "session-1",
    status: "completed",
    updatedAt: "2026-01-01T00:00:00.000Z",
    summary: "a"
  });
  writeStoredJob(dataDir, "ws-b", {
    id: "codex-b",
    sessionId: "session-2",
    status: "failed",
    updatedAt: "2026-01-02T00:00:00.000Z",
    summary: "b"
  });
  writeStoredJob(dataDir, "ws-b", {
    id: "codex-c",
    sessionId: "session-1",
    status: "running",
    updatedAt: "2026-01-03T00:00:00.000Z",
    summary: "c"
  });
  const mine = listStoredCodexJobs(dataDir, { sessionId: "session-1" });
  assert.deepEqual(
    mine.map((job) => job.id),
    ["codex-c", "codex-a"]
  );
  const terminal = listStoredCodexJobs(dataDir, { sessionId: "session-1", terminalOnly: true });
  assert.deepEqual(
    terminal.map((job) => job.id),
    ["codex-a"]
  );
  assert.equal(findStoredCodexJob(dataDir, "codex-b").status, "failed");
});

/* ------------------------------ operations -------------------------------- */

test("foreground result carries Codex thread continuity metadata", async () => {
  const env = opEnv({ runner: createFakeRunner(() => ({ stdout: "REVIEW OK\n" })) });
  writeStoredJob(env.dataDir, "ws", {
    id: "codex-1",
    status: "completed",
    threadId: "thread-1",
    rendered: "REVIEW OK",
    updatedAt: new Date().toISOString()
  });
  const result = await env.operations.review(env.exec, {});
  assert.match(result.text, /REVIEW OK/);
  assert.match(result.text, /Codex session: thread-1/);
  assert.match(result.text, /codex resume thread-1/);
});

test("terminal stored result is served without spawning a companion process", async () => {
  const env = opEnv();
  writeStoredJob(env.dataDir, "ws", {
    id: "job-fast",
    status: "completed",
    rendered: "STORED RESULT",
    updatedAt: new Date().toISOString()
  });
  const result = await env.operations.result(env.exec, { job_id: "job-fast" });
  assert.match(result.text, /STORED RESULT/);
  assert.equal(env.runner.calls.length, 0, "fast path must not spawn node");
});

test("status falls back to this session's records in other workspaces", async () => {
  const env = opEnv({
    runner: createFakeRunner(() => ({ stdout: "No jobs recorded yet.\n" }))
  });
  writeStoredJob(env.dataDir, "other-ws", {
    id: "job-elsewhere",
    sessionId: "session-1",
    status: "completed",
    summary: "older workspace job",
    updatedAt: new Date().toISOString()
  });
  const result = await env.operations.status(env.exec, {});
  assert.match(result.text, /other workspaces/i);
  assert.match(result.text, /job-elsewhere/);
});

test("setup readiness is cached and force bypasses the cache", async () => {
  let calls = 0;
  const env = opEnv({
    runner: createFakeRunner(() => {
      calls += 1;
      return { stdout: `# Codex Setup\n\nStatus: ready\n\nsetup report ${calls}\n` };
    })
  });
  const first = await env.operations.setup(env.exec, {});
  const second = await env.operations.setup(env.exec, {});
  assert.match(first.text, /setup report 1/);
  assert.match(second.text, /cached/);
  assert.equal(calls, 1);
  const forced = await env.operations.setup(env.exec, { force: true });
  assert.match(forced.text, /setup report 2/);
  assert.equal(calls, 2);
});

test("setup never caches a report that needs attention", async () => {
  let calls = 0;
  const env = opEnv({
    runner: createFakeRunner(() => {
      calls += 1;
      return { stdout: `# Codex Setup\n\nStatus: needs attention\n\n- auth: not authenticated (${calls})\n` };
    })
  });
  await env.operations.setup(env.exec, {});
  const second = await env.operations.setup(env.exec, {});
  assert.equal(calls, 2, "a failed readiness check is re-run, not served from cache");
  assert.doesNotMatch(second.text, /cached/);
});

test("resume_last without a task runs without a prompt file", async () => {
  const env = opEnv({ runner: createFakeRunner(() => ({ stdout: "RESUMED\n" })) });
  const result = await env.operations.rescue(env.exec, { resume_last: true });
  assert.match(result.text, /RESUMED/);
  const argv = env.runner.calls[0].argv;
  assert.ok(argv.includes("--resume-last"));
  assert.equal(argv.includes("--prompt-file"), false);
});

test("unknown-job cancellation reports failure instead of success", async () => {
  const env = opEnv({
    runner: createFakeRunner(() => ({ code: 1, stderr: "No active job found for \"nope\".\n" }))
  });
  await assert.rejects(
    () => env.operations.cancel(env.exec, { job_id: "nope" }),
    /No active Codex job with id nope/
  );
});

test("cancelling without an id refuses to guess between two live jobs", async () => {
  const pending = [];
  const env = opEnv({
    runner: createFakeRunner(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        })
    )
  });
  await env.operations.review(env.exec, { background: true });
  await env.operations.review(env.exec, { background: true });
  await assert.rejects(() => env.operations.cancel(env.exec, {}), /Multiple Codex jobs/);
  for (const resolve of pending) {
    resolve({ stdout: "done\n" });
  }
});

test("background start failure cleans up the prompt file", async () => {
  const dataDir = tmpDir("dsh-codex-leak-");
  // No jobs service -> background start throws before registering.
  const operations = createOperations({
    ctx: {
      workingDirectory: { get: () => tmpDir("dsh-codex-leak-cwd-"), defaultDirectory: "/tmp" },
      get: () => undefined
    },
    runner: createFakeRunner(() => ({ stdout: "" }), { dataDir })
  });
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("dsh-codex-prompt-"));
  await assert.rejects(
    () =>
      operations.rescue(
        { agent: { id: "session-1", session: { id: "session-1" } } },
        { task: "do something", background: true }
      ),
    /background-job service/
  );
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("dsh-codex-prompt-"));
  assert.deepEqual(after, before, "no prompt temp directory may leak");
});

test("jobs.py cancellation hook interrupts the Codex turn through the companion", async () => {
  const env = opEnv({
    runner: createFakeRunner(
      (argv) =>
        new Promise((resolve) => {
          if (argv[0] === "cancel") {
            resolve({ stdout: "cancelled\n" });
            return;
          }
          // Keep the run alive until the test cancels it.
          setTimeout(() => resolve({ stdout: "done\n" }), 50);
        })
    )
  });
  const started = await env.operations.review(env.exec, { background: true });
  const jobId = /background job (\S+?)\./.exec(started.text)[1];
  env.jobs.kill(jobId, "session-1", "test cancel");
  // The producer awaits the companion cancel before settling the job.
  await env.jobs.record(jobId)?.promise;
  assert.ok(
    env.runner.calls.some((call) => call.argv[0] === "cancel" && call.argv.includes(jobId)),
    "cancel asks the companion to interrupt the turn"
  );
});

/* --------------------- second review round regressions --------------------- */

test("relative cwd resolves against the session directory, not the Host process cwd", async () => {
  const sessionDir = tmpDir("dsh-codex-relcwd-");
  fs.mkdirSync(path.join(sessionDir, "sub"));
  const dataDir = tmpDir("dsh-codex-relcwd-data-");
  const runner = createFakeRunner(() => ({ stdout: "ok\n" }), { dataDir });
  const operations = createOperations({
    ctx: {
      workingDirectory: { get: () => sessionDir, defaultDirectory: sessionDir },
      get: () => undefined
    },
    runner
  });
  const exec = { agent: { id: "session-1", session: { id: "session-1" } } };
  await operations.setup(exec, { cwd: ".", force: true });
  const argv = runner.calls.at(-1).argv;
  assert.equal(argv[argv.indexOf("--cwd") + 1], sessionDir);
  await operations.setup(exec, { cwd: "sub", force: true });
  assert.equal(runner.calls.at(-1).argv[runner.calls.at(-1).argv.indexOf("--cwd") + 1], path.join(sessionDir, "sub"));
});

test("dataDir lookup works without executable discovery, and ready() recovers after a failure", () => {
  const config = { codexPath: "/nonexistent/codex-binary" };
  const runner = createRunner(config);
  // Stored-result fast paths must work even when Codex is unavailable.
  assert.equal(typeof runner.dataDir(), "string");
  assert.ok(runner.dataDir().length > 0);
  assert.throws(() => runner.ready(), /not an executable/);

  const realCodex = "/opt/homebrew/bin/codex";
  if (!fs.existsSync(realCodex)) {
    return;
  }
  config.codexPath = realCodex;
  const recovered = runner.ready();
  assert.equal(recovered.codex.command, realCodex);
});

test("failed Codex turns persist a diagnostic the stored-result renderer shows", async () => {
  const stateModule = await import("../runtime/scripts/lib/tracked-jobs.mjs");
  const stateStore = await import("../runtime/scripts/lib/state.mjs");
  const saved = process.env.CODEX_COMPANION_DATA_DIR;
  const dataDir = tmpDir("dsh-codex-fail-");
  process.env.CODEX_COMPANION_DATA_DIR = dataDir;
  try {
    const cwd = tmpDir("dsh-codex-fail-cwd-");
    const logFile = path.join(dataDir, "job.log");
    const job = {
      id: "job-failed",
      kind: "task",
      title: "Codex Task",
      summary: "original task text",
      workspaceRoot: cwd
    };
    await stateModule.runTrackedJob(
      job,
      async () => ({
        exitStatus: 1,
        summary: "Codex could not finish",
        rendered: "Fatal: app-server disconnected",
        payload: { rawOutput: "Fatal: app-server disconnected" }
      }),
      { logFile }
    );
    const stored = stateStore.readJobFile(stateStore.resolveJobFile(cwd, "job-failed"));
    assert.equal(stored.status, "failed");
    assert.match(stored.errorMessage, /app-server disconnected/);
    assert.match(stored.summary, /could not finish/);
    const rendered = renderStoredCodexJob(stored);
    assert.match(rendered, /Status: failed/);
    assert.match(rendered, /Error: .*app-server disconnected/);
  } finally {
    if (saved === undefined) {
      delete process.env.CODEX_COMPANION_DATA_DIR;
    } else {
      process.env.CODEX_COMPANION_DATA_DIR = saved;
    }
  }
});

test("untracked symlinks are described, not inlined, in review context", async () => {
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    return;
  }
  const { collectReviewContext } = await import("../runtime/scripts/lib/git.mjs");
  const repo = tmpDir("dsh-codex-git-");
  const secretDir = tmpDir("dsh-codex-secret-");
  const secret = path.join(secretDir, "credentials.txt");
  fs.writeFileSync(secret, "SECRET_MARKER_SHOULD_NOT_LEAK\n", "utf8");
  fs.writeFileSync(path.join(repo, "tracked.js"), "export const x = 1;\n", "utf8");
  const git = (...args) =>
    spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
      cwd: repo,
      encoding: "utf8"
    });
  git("init", "-q");
  git("add", "tracked.js");
  git("commit", "-qm", "baseline");
  fs.writeFileSync(path.join(repo, "tracked.js"), "export const x = 2;\n", "utf8");
  fs.symlinkSync(secret, path.join(repo, "leaky-link"));

  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff", explicit: false });
  assert.doesNotMatch(context.content, /SECRET_MARKER_SHOULD_NOT_LEAK/);
  assert.match(context.content, /leaky-link/);
  assert.match(context.content, /symlink/);
});

/* --------------------- protocol server-request responses ------------------- */

test("headless app-server requests get typed refusals, not method-not-found", async () => {
  const { respondToServerRequest, HEADLESS_REJECTION } = await import(
    "../runtime/scripts/lib/server-requests.mjs"
  );
  assert.deepEqual(respondToServerRequest({ method: "item/commandExecution/requestApproval" }), {
    result: { decision: "decline" }
  });
  assert.deepEqual(respondToServerRequest({ method: "item/fileChange/requestApproval" }), {
    result: { decision: "decline" }
  });
  assert.deepEqual(respondToServerRequest({ method: "item/permissions/requestApproval" }), {
    result: { permissions: {}, scope: "turn" }
  });
  assert.deepEqual(respondToServerRequest({ method: "item/tool/requestUserInput" }), {
    result: { answers: {} }
  });
  assert.deepEqual(respondToServerRequest({ method: "mcpServer/elicitation/request" }), {
    result: { action: "decline", content: null, _meta: null }
  });
  const dynamicTool = respondToServerRequest({ method: "item/tool/call" });
  assert.equal(dynamicTool.result.success, false);
  assert.equal(dynamicTool.result.contentItems[0].type, "inputText");

  // Legacy approval RPCs use ReviewDecision: plain "denied" is invalid.
  for (const method of ["applyPatchApproval", "execCommandApproval"]) {
    const response = respondToServerRequest({ method });
    assert.deepEqual(response.result.decision, { denied: { rejection: HEADLESS_REJECTION } });
  }

  // No denial-shaped success exists for these; they must be protocol errors.
  for (const method of ["account/chatgptAuthTokens/refresh", "attestation/generate"]) {
    const response = respondToServerRequest({ method });
    assert.equal(typeof response.error?.code, "number");
    assert.match(response.error.message, /DeepSeek Harness/);
  }
  assert.match(respondToServerRequest({ method: "future/method" }).error.message, /Unsupported/);
  // Every response carries an id-agnostic payload; the client echoes the id.
  assert.ok(!("id" in respondToServerRequest({ method: "item/fileChange/requestApproval" })));
});

/* --------------------------- write approval gate --------------------------- */

test("write runs require Harness approval and refuse when it is not granted", async () => {
  const env = opEnv({
    approvalOutcome: "rejected",
    runner: createFakeRunner(() => ({ stdout: "should not run\n" }))
  });
  const result = await env.operations.rescue(env.exec, {
    task: "change something",
    write: true
  });
  assert.match(result.text, /not granted \(rejected\)/);
  assert.equal(env.runner.calls.length, 0, "no Codex process may start");
  assert.equal(env.approvalCalls.length, 1);
  assert.equal(env.approvalCalls[0].toolName, "codex_rescue");
});

test("allowed-once approval starts the write run", async () => {
  const env = opEnv({ approvalOutcome: "allowed-once" });
  const result = await env.operations.rescue(env.exec, { task: "edit", write: true });
  assert.match(result.text, /OK/);
  assert.equal(env.approvalCalls.length, 1);
  assert.ok(env.runner.calls[0].argv.includes("--write"));
});

test("writeApproval allow preauthorizes, deny never launches", async () => {
  const allowed = opEnv({ config: { writeApproval: "allow" } });
  await allowed.operations.rescue(allowed.exec, { task: "edit", write: true });
  assert.equal(allowed.approvalCalls.length, 0);
  assert.ok(allowed.runner.calls[0].argv.includes("--write"));

  const denied = opEnv({ config: { writeApproval: "deny" } });
  const deniedResult = await denied.operations.rescue(denied.exec, { task: "edit", write: true });
  assert.match(deniedResult.text, /disabled by the plugin configuration/);
  assert.equal(denied.runner.calls.length, 0);
});

test("missing approval service fails closed for tool write runs", async () => {
  const env = opEnv({ approval: null });
  // opEnv's null approval falls back to the default service; simulate absence.
  const dataDir = tmpDir("dsh-codex-noapproval-");
  const runner = createFakeRunner(() => ({ stdout: "" }), { dataDir });
  const operations = createOperations({
    ctx: {
      workingDirectory: { get: () => process.cwd(), defaultDirectory: process.cwd() },
      get: () => undefined
    },
    runner
  });
  const result = await operations.rescue(
    { agent: { id: "session-1", session: { id: "session-1" } }, signal: new AbortController().signal },
    { task: "edit", write: true }
  );
  assert.match(result.text, /no approval service\/agent is available/);
  assert.equal(runner.calls.length, 0);
});

test("human slash-command --write is explicit consent and skips the approval prompt", async () => {
  const env = opEnv();
  const result = await env.operations.rescue(
    { ...env.exec, fromCommand: true },
    { task: "edit", write: true }
  );
  assert.match(result.text, /OK/);
  assert.equal(env.approvalCalls.length, 0);
});

test("non-boolean write values are rejected before any approval or spawn", async () => {
  const env = opEnv();
  await assert.rejects(
    () => env.operations.rescue(env.exec, { task: "edit", write: "true" }),
    /write must be a boolean/
  );
  assert.equal(env.approvalCalls.length, 0);
  assert.equal(env.runner.calls.length, 0);
});

/* --------------------- broker idle reaper and tree kill -------------------- */

test("broker reaping ignores active turns and recent activity", async () => {
  const { shouldReapBroker } = await import("../runtime/scripts/lib/broker-idle.mjs");
  const base = { lastActivityAt: 0, idleTimeoutMs: 600000, now: 700000 };
  assert.equal(shouldReapBroker(base), true);
  assert.equal(shouldReapBroker({ ...base, activeRequest: true }), false);
  assert.equal(shouldReapBroker({ ...base, activeStream: true }), false);
  assert.equal(shouldReapBroker({ ...base, now: 500000 }), false);
  assert.equal(shouldReapBroker({ ...base, idleTimeoutMs: 0 }), false);
});

test("process-tree termination uses taskkill on Windows and process groups on POSIX", async () => {
  const { terminateTreeImpl } = await import("../lib/process.js");
  const child = { exitCode: null, pid: 4242, kill() {} };
  const winCalls = [];
  terminateTreeImpl({
    child: { ...child },
    platform: "win32",
    killTree: (pid) => winCalls.push(pid),
    killProcess: () => {
      throw new Error("must not use process.kill on Windows");
    }
  });
  assert.deepEqual(winCalls, [4242]);

  const posixCalls = [];
  terminateTreeImpl({
    child: { ...child },
    platform: "linux",
    killTree: () => {
      throw new Error("must not use taskkill on POSIX");
    },
    killProcess: (pid, signal) => posixCalls.push([pid, signal])
  });
  assert.deepEqual(posixCalls, [[-4242, "SIGTERM"]]);

  // Falls back to the direct child kill when the group kill throws.
  let direct = null;
  terminateTreeImpl({
    child: {
      exitCode: null,
      pid: 7,
      kill(signal) {
        direct = signal;
      }
    },
    platform: "linux",
    killProcess: () => {
      throw new Error("no group");
    }
  });
  assert.equal(direct, "SIGTERM");
});

/* ------------------------- fallbacks and validation ------------------------ */

test("stored results are served when the Codex CLI cannot even be spawned", async () => {
  const dataDir = tmpDir("dsh-codex-nospawn-");
  writeStoredJob(dataDir, "ws", {
    id: "job-stored",
    status: "completed",
    sessionId: "session-1",
    rendered: "STORED AFTER FAILURE",
    updatedAt: new Date().toISOString()
  });
  const runner = createFakeRunner(
    () => {
      throw new Error("Codex CLI was not found");
    },
    { dataDir }
  );
  const operations = createOperations({
    ctx: {
      workingDirectory: { get: () => process.cwd(), defaultDirectory: process.cwd() },
      get: () => undefined
    },
    runner
  });
  const exec = { agent: { id: "session-1", session: { id: "session-1" } } };
  const result = await operations.result(exec, { job_id: "job-stored" });
  assert.match(result.text, /STORED AFTER FAILURE/);
  const status = await operations.status(exec, { job_id: "job-stored" });
  assert.match(status.text, /Status: completed/);
});

test("invalid timeout_ms is rejected instead of silently using the default", async () => {
  const env = opEnv();
  await assert.rejects(() => env.operations.status(env.exec, { timeout_ms: 0 }), /positive integer/);
  await assert.rejects(() => env.operations.status(env.exec, { timeout_ms: "abc" }), /positive integer/);
});

test("command flag values may contain =", () => {
  const parsed = parseCommandInput("--base=origin/a=b", { valueFlags: ["base"] });
  assert.equal(parsed.flags.base, "origin/a=b");
});

test("status snapshot and setup report build without the removed review-gate config", async () => {
  const jobControl = await import("../runtime/scripts/lib/job-control.mjs");
  const cwd = tmpDir("dsh-codex-status-");
  const snapshot = jobControl.buildStatusSnapshot(cwd, {});
  assert.equal(typeof snapshot.workspaceRoot, "string");
  assert.equal(Array.isArray(snapshot.running), true);
  assert.equal("needsReview" in snapshot, false);
});

test("literal task text preserves quotes, spacing and === verbatim", () => {
  const parsed = parseCommandInput('-- Explain status === "failed"  and keep it', {
    boolFlags: ["write"]
  });
  assert.deepEqual(parsed.flags, {});
  assert.deepEqual(parsed.positionals, ['Explain status === "failed"  and keep it']);

  const mixed = parseCommandInput('--model "gpt 5" fix "a b" --write', {
    valueFlags: ["model"],
    boolFlags: ["write"]
  });
  assert.deepEqual(mixed.flags, { model: "gpt 5" });
  assert.deepEqual(mixed.positionals, ['fix "a b" --write']);
});

test("broker turn tracker exposes the pending turn for interruption", async () => {
  const { createTurnTracker } = await import("../runtime/scripts/lib/broker-turns.mjs");
  const tracker = createTurnTracker();
  tracker.noteStreamingResult("turn/start", { threadId: "thread-1" }, { turn: { id: "turn-1" } });
  tracker.noteNotification({ method: "turn/started", params: { threadId: "thread-2", turn: { id: "turn-2" } } });
  assert.deepEqual(tracker.targets(["thread-1", "thread-2", "thread-3"]), [
    { threadId: "thread-1", turnId: "turn-1" },
    { threadId: "thread-2", turnId: "turn-2" }
  ]);
  // A completed turn is no longer a cancellation target.
  tracker.noteNotification({ method: "turn/completed", params: { threadId: "thread-1" } });
  assert.deepEqual(tracker.targets(["thread-1"]), []);
});
