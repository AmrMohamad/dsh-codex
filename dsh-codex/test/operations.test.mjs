import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { createOperations } from "../lib/operations.js";
import { createFakeJobs, createFakeRunner } from "./fakes.mjs";

function operationEnv(options = {}) {
  const jobs = Object.prototype.hasOwnProperty.call(options, "jobs") ? options.jobs : createFakeJobs();
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "dsh-codex-data-"));
  const baseRunner = options.runner;
  const runner = baseRunner ?? createFakeRunner(() => ({ stdout: "OK\n" }), { dataDir });
  runner.dataDir = runner.dataDir ?? (() => dataDir);
  const cwd = options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "dsh-codex-ops-"));
  const approvalCalls = [];
  const approvalService = options.approval ?? {
    async request(request) {
      approvalCalls.push(request);
      return options.approvalOutcome ?? "allowed-once";
    }
  };
  const ctx = {
    workingDirectory: {
      get: () => cwd,
      defaultDirectory: cwd,
      ensure: async () => cwd
    },
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
  const operations = createOperations({ ctx, runner });
  const exec = {
    agent: { id: "session-1", session: { id: "session-1" } },
    callId: "call-1",
    rootCallId: "call-1",
    signal: new AbortController().signal
  };
  return { cwd, jobs, runner, operations, exec, approvalCalls };
}

test("review foreground starts a job, returns rendered output, and removes the job", async () => {
  const env = operationEnv({
    runner: createFakeRunner(() => ({ stdout: "REVIEW RESULT\n" }))
  });
  const result = await env.operations.review(env.exec, {});
  assert.equal(result.text, "REVIEW RESULT");
  assert.equal(env.jobs.started.length, 1);
  const record = env.jobs.started[0];
  assert.equal(record.spec.kind, "codex");
  assert.equal(record.spec.owner, "session-1");
  assert.match(record.spec.label, /review/i);
  assert.deepEqual(env.runner.calls[0].argv.slice(0, 2), ["review", "--cwd"]);
  assert.equal(env.jobs.list().length, 0, "foreground job record is collected and removed");
});

test("review background returns the job id and keeps the job owned by the session", async () => {
  const env = operationEnv();
  const result = await env.operations.review(env.exec, { background: true, base: "main" });
  assert.match(result.text, /background job codex-1/);
  const record = env.jobs.started[0];
  assert.equal(record.spec.owner, "session-1");
  assert.deepEqual(record.spec.toolCall, { callId: "call-1", rootCallId: "call-1" });
  assert.ok(env.runner.calls[0].argv.includes("--base"));
  await record.promise;
});

test("background without the jobs service fails with actionable guidance", async () => {
  const env = operationEnv({ jobs: undefined });
  await assert.rejects(
    () => env.operations.review(env.exec, { background: true }),
    /background-job service/
  );
});

test("rescue passes write/model/effort/resume flags and cleans up the prompt file", async () => {
  let promptPath = null;
  const env = operationEnv({
    runner: createFakeRunner((argv) => {
      promptPath = argv[argv.indexOf("--prompt-file") + 1];
      assert.ok(fs.existsSync(promptPath), "prompt file exists while companion runs");
      assert.equal(fs.readFileSync(promptPath, "utf8"), "fix the flaky test");
      return { stdout: "TASK RESULT\n" };
    })
  });
  const result = await env.operations.rescue(env.exec, {
    task: "fix the flaky test",
    write: true,
    model: "gpt-5.3-codex-spark",
    effort: "high",
    resume_last: true
  });
  assert.equal(result.text, "TASK RESULT");
  const argv = env.runner.calls[0].argv;
  for (const flag of ["--write", "--model", "--effort", "--resume-last", "--prompt-file"]) {
    assert.ok(argv.includes(flag), `argv contains ${flag}`);
  }
  assert.equal(fs.existsSync(promptPath), false, "prompt file removed after the run");
});

test("rescue without task or resume_last is rejected", async () => {
  const env = operationEnv();
  await assert.rejects(() => env.operations.rescue(env.exec, {}), /Provide a task/);
});

test("adversarial review writes focus text to a temp file", async () => {
  let focusPath = null;
  const env = operationEnv({
    runner: createFakeRunner((argv) => {
      focusPath = argv[argv.indexOf("--focus-file") + 1];
      assert.equal(fs.readFileSync(focusPath, "utf8"), "challenge the retry design");
      return { stdout: "ADVERSARIAL\n" };
    })
  });
  const result = await env.operations.adversarialReview(env.exec, {
    focus: "challenge the retry design"
  });
  assert.equal(result.text, "ADVERSARIAL");
  assert.equal(fs.existsSync(focusPath), false);
});

test("foreground failure rejects with the companion stderr", async () => {
  const env = operationEnv({
    runner: createFakeRunner(() => ({ code: 1, stderr: "No git repository here\n" }))
  });
  await assert.rejects(() => env.operations.review(env.exec, {}), /No git repository here/);
});

test("status/result/setup return rendered companion output", async () => {
  const env = operationEnv({
    runner: createFakeRunner((argv) => ({ stdout: `rendered:${argv[0]}\n` }))
  });
  assert.equal((await env.operations.status(env.exec, {})).text, "rendered:status");
  assert.equal((await env.operations.result(env.exec, {})).text, "rendered:result");
  assert.equal((await env.operations.setup(env.exec, {})).text, "rendered:setup");
});

test("status wait without job id is rejected", async () => {
  const env = operationEnv();
  await assert.rejects(() => env.operations.status(env.exec, { wait: true }), /needs a job_id/);
});

test("cancel kills a live owned Codex job and asks the companion to interrupt", async () => {
  let releaseRun;
  const env = operationEnv({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "dsh-codex-data-")),
    runner: createFakeRunner(
      (argv) =>
        new Promise((resolve) => {
          if (argv[0] === "cancel") {
            resolve({ stdout: "cancel report\n" });
            return;
          }
          releaseRun = () => resolve({ stdout: "finished\n" });
        })
    )
  });
  await env.operations.review(env.exec, { background: true });
  const killTarget = env.jobs.started[0].id;
  const result = await env.operations.cancel(env.exec, { job_id: killTarget });
  releaseRun?.();
  assert.match(result.text, new RegExp(`Cancellation requested for Codex job ${killTarget}`));
  assert.equal(env.jobs.kills.length, 1);
  assert.equal(env.jobs.kills[0].id, killTarget);
  // Cancellation is settled by the producer: wait for the job's terminal state.
  await env.jobs.record(killTarget)?.promise;
  const cancelCall = env.runner.calls.find((call) => call.argv[0] === "cancel");
  assert.ok(cancelCall, "companion cancel is invoked");
});

test("foreground failure with stderr-only output includes the stderr text", async () => {
  const env = operationEnv({
    runner: createFakeRunner(() => ({ code: 2, stdout: "", stderr: "boom\n" }))
  });
  await assert.rejects(() => env.operations.result(env.exec, {}), /boom/);
});
