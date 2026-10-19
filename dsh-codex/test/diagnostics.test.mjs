import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";

import { diagnoseCodexFailure, withFailureHint } from "../lib/diagnose.js";
import { startCodexJob } from "../lib/jobs.js";
import { createRunner } from "../lib/runtime.js";
import { shorten } from "../lib/text.js";
import { createFakeJobs, createFakeRunner } from "./fakes.mjs";

test("known Codex failures get one actionable hint", () => {
  assert.match(diagnoseCodexFailure("Codex error: You've hit your usage limit. Try again later."), /usage or rate limit/);
  assert.match(diagnoseCodexFailure("stream error: 429 Too Many Requests"), /Do not retry now/);
  assert.match(diagnoseCodexFailure("refresh_token_reused: token already used"), /codex login/);
  assert.match(diagnoseCodexFailure("unexpected status 401 Unauthorized"), /codex login/);
  assert.match(diagnoseCodexFailure("The Codex CLI was not found."), /codex_setup/);
  assert.equal(diagnoseCodexFailure("TypeError: x is not a function"), null);
});

test("withFailureHint appends the hint without replacing the error", () => {
  assert.equal(withFailureHint("plain failure"), "plain failure");
  const once = withFailureHint("429 Too Many Requests");
  assert.equal(withFailureHint(once), once, "idempotent");
  const text = withFailureHint("Codex companion exited with code 1.", "Codex error: usage limit reached");
  assert.match(text, /^Codex companion exited with code 1\.\nHint: /);
});

test("a failed background job explains itself even though output is not captured", async () => {
  const jobs = createFakeJobs();
  const runner = createFakeRunner((_argv, options) => {
    assert.equal(options.capture, false, "job runs stream into the job ring only");
    return {
      code: 1,
      stdout: "# Codex Review\n\nCodex review failed: You've hit your usage limit.\n",
      stderr: "[codex] Thread ready (thr-1).\n[codex] Codex error: You've hit your usage limit.\n"
    };
  });
  const id = startCodexJob({
    jobs,
    runner,
    label: "Codex review",
    cwd: process.cwd(),
    sessionId: "session-1",
    buildArgv: (jobId) => ["review", "--job-id", jobId]
  });
  const view = await jobs.wait(id);
  assert.equal(view.status, "failed");
  assert.match(view.detail, /exited with code 1/);
  assert.match(view.detail, /usage limit/);
  assert.match(view.detail, /Hint: Codex hit an account usage or rate limit/);
});

test("a failed foreground run reports its stderr and hint exactly once", async () => {
  const { runCodexForeground } = await import("../lib/jobs.js");
  const jobs = createFakeJobs();
  const runner = createFakeRunner(() => ({
    code: 1,
    stderr: "[codex] Codex error: You've hit your usage limit.\n"
  }));
  const ctx = { get: (name) => (name === "jobs" ? jobs : undefined) };
  await assert.rejects(
    runCodexForeground({
      ctx,
      exec: { signal: new AbortController().signal },
      runner,
      label: "Codex task",
      cwd: process.cwd(),
      sessionId: "session-1",
      buildArgv: (jobId) => ["task", "--job-id", jobId]
    }),
    (error) => {
      assert.equal(error.message.match(/Hint:/g)?.length, 1);
      assert.equal(error.message.match(/hit your usage limit/g)?.length, 1);
      return true;
    }
  );
});

test("createRunner keeps a resolved Node while Codex is still missing", () => {
  let nodePathReads = 0;
  const config = {
    get nodePath() {
      nodePathReads += 1;
      return process.execPath;
    },
    codexPath: "/nonexistent/codex"
  };
  const runner = createRunner(config);
  assert.throws(() => runner.ready(), /codexPath is not an executable file/);
  const readsAfterFirst = nodePathReads;
  assert.throws(() => runner.ready(), /codexPath is not an executable file/);
  assert.equal(nodePathReads, readsAfterFirst, "Node is not re-probed on every call");
});

test("plugin-layer shorten is surrogate-safe and ellipsized", () => {
  assert.equal(shorten("abcdefg\u{1F600}xyz", 9), "abcdefg…");
  assert.equal(shorten("  many   spaces  here ", 72), "many spaces here");
});
