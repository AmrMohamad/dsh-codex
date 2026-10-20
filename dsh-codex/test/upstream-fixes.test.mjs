/**
 * Regression tests for bugs reported against the upstream runtime
 * (openai/codex-plugin-cc and openai/codex) that the vendored copy inherited.
 * Each test names the upstream issue it guards. See docs/RESEARCH.md.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import { test } from "node:test";

import { parseArgs } from "../runtime/scripts/lib/args.mjs";
import { buildResultStatus, captureTurn, shorten } from "../runtime/scripts/lib/codex.mjs";
import { collectReviewContext } from "../runtime/scripts/lib/git.mjs";

const HAS_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function tmpRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-codex-upstream-"));
  const git = (...args) =>
    spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
      cwd: repo,
      encoding: "utf8"
    });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "a\n", "utf8");
  git("add", "tracked.txt");
  git("commit", "-qm", "baseline");
  return repo;
}

const WORKING_TREE = { mode: "working-tree", label: "working tree diff", explicit: false };

/* ---------------------------------- args ---------------------------------- */

test("#807: inline --key=value keeps every '=' after the first", () => {
  const { options } = parseArgs(["--base=refs/x=y", "--model=a=b=c"], { valueOptions: ["base", "model"] });
  assert.equal(options.base, "refs/x=y");
  assert.equal(options.model, "a=b=c");
});

/* ------------------------------ review context ----------------------------- */

test("#813: git status keeps its leading column in review context", { skip: !HAS_GIT }, () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, "tracked.txt"), "a\nb\n", "utf8");
  const context = collectReviewContext(repo, WORKING_TREE);
  assert.match(context.content, /^ M tracked\.txt$/m);
});

test("#812: non-ASCII untracked file names are read, not skipped", { skip: !HAS_GIT }, () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, "café.js"), "export const cafe = 1;\n", "utf8");
  const context = collectReviewContext(repo, WORKING_TREE);
  assert.deepEqual(context.changedFiles, ["café.js"]);
  assert.match(context.content, /### café\.js\n```\nexport const cafe = 1;/);
  assert.doesNotMatch(context.content, /\\303/);
});

test("untracked file bodies share one bounded prompt budget", { skip: !HAS_GIT }, () => {
  const repo = tmpRepo();
  const body = `${"x".repeat(20 * 1024)}\n`;
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(path.join(repo, `gen-${String(index).padStart(2, "0")}.txt`), body, "utf8");
  }
  const context = collectReviewContext(repo, WORKING_TREE);
  // 40 x 20 KiB would be ~800 KiB of prompt; the budget keeps it near 64 KiB.
  assert.ok(Buffer.byteLength(context.content, "utf8") < 128 * 1024, "untracked context is bounded");
  assert.match(context.content, /more untracked file\(s\) not inlined/);
  assert.equal(context.changedFiles.length, 40, "every file is still listed");
});

/* --------------------------------- shorten --------------------------------- */

test("#793: shorten never leaves a lone UTF-16 surrogate", () => {
  // The emoji straddles the cut point (limit 10 -> cut at 7 code units).
  const shortened = shorten("abcdef\u{1F600}ghijklmnop", 10);
  assert.equal(shortened, "abcdef...");
  assert.doesNotMatch(shortened, /[\uD800-\uDFFF]/);
  assert.equal(shorten("plain ascii text that is long", 10), "plain a...");
});

/* ------------------------------- turn capture ------------------------------ */

function fakeClient() {
  return {
    notificationHandler: null,
    closed: false,
    exitError: null,
    exitPromise: new Promise(() => {}),
    setNotificationHandler(handler) {
      this.notificationHandler = handler;
    },
    emit(method, params) {
      this.notificationHandler?.({ method, params });
    }
  };
}

function finishTurnSoon(client, { error, willRetry, text } = {}) {
  setImmediate(() => {
    if (error) {
      client.emit("error", { threadId: "thread-1", turnId: "turn-1", willRetry, error: { message: error } });
    }
    if (text) {
      client.emit("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "m1", text, phase: "final_answer" }
      });
    }
    client.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  });
}

test("#781: a start response without turn.id still completes the turn", async () => {
  const client = fakeClient();
  const capture = captureTurn(client, "thread-1", async () => {
    client.emit("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    finishTurnSoon(client, { text: "done" });
    return { turn: {} };
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("captureTurn hung")), 2000).unref());
  const state = await Promise.race([capture, timeout]);
  assert.equal(state.turnId, "turn-1");
  assert.equal(state.lastAgentMessage, "done");
  assert.equal(buildResultStatus(state), 0);
});

test("openai/codex#47728: a fatal error before an empty turn/completed is a failure", async () => {
  const client = fakeClient();
  const state = await captureTurn(client, "thread-1", async () => {
    finishTurnSoon(client, { error: "You've hit your usage limit." });
    return { turn: { id: "turn-1", status: "inProgress" } };
  });
  assert.equal(state.error?.message, "You've hit your usage limit.");
  assert.equal(buildResultStatus(state), 1);
});

test("a retried (willRetry) error does not fail a turn that produced output", async () => {
  const client = fakeClient();
  const state = await captureTurn(client, "thread-1", async () => {
    finishTurnSoon(client, { error: "stream disconnected; retrying", willRetry: true, text: "ok" });
    return { turn: { id: "turn-1", status: "inProgress" } };
  });
  assert.equal(state.error, null);
  assert.equal(buildResultStatus(state), 0);
  // A final error is ignored when the turn still produced its answer.
  assert.equal(buildResultStatus({ ...state, error: { message: "late" } }), 0);
});

/* ---------------------------- broker lifecycle ---------------------------- */

test("#789/#801: a broker that misses its readiness window is killed, not abandoned", {
  skip: process.platform === "win32"
}, async () => {
  const { ensureBrokerSession } = await import("../runtime/scripts/lib/broker-lifecycle.mjs");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-codex-broker-"));
  const pidOut = path.join(scratch, "pid.txt");
  // A "broker" that records its pid and never opens its endpoint.
  const script = path.join(scratch, "silent-broker.mjs");
  fs.writeFileSync(
    script,
    `import fs from "node:fs"; fs.writeFileSync(process.env.TEST_PID_OUT, String(process.pid)); setInterval(() => {}, 1e6);\n`
  );
  const saved = process.env.CODEX_COMPANION_DATA_DIR;
  process.env.CODEX_COMPANION_DATA_DIR = path.join(scratch, "data");
  try {
    const session = await ensureBrokerSession(scratch, {
      scriptPath: script,
      timeoutMs: 1500,
      env: { ...process.env, TEST_PID_OUT: pidOut }
    });
    assert.equal(session, null);
  } finally {
    if (saved === undefined) {
      delete process.env.CODEX_COMPANION_DATA_DIR;
    } else {
      process.env.CODEX_COMPANION_DATA_DIR = saved;
    }
  }
  const pid = Number(fs.readFileSync(pidOut, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 40 && alive(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const leaked = alive();
  if (leaked) {
    process.kill(pid, "SIGKILL");
  }
  assert.equal(leaked, false, "the abandoned broker process must not survive");
});
