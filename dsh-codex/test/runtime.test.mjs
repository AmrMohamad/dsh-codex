import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import {
  adversarialReviewArgv,
  cancelArgv,
  resultArgv,
  reviewArgv,
  setupArgv,
  statusArgv,
  taskArgv
} from "../lib/argv.js";
import { buildChildEnv, removePromptFile, writePromptFile } from "../lib/process.js";
import { resolveCodex, resolveDataDir, resolveNode } from "../lib/resolve.js";
import { createRunner } from "../lib/runtime.js";
import { cleanOutput } from "../lib/text.js";
import { chunksToText } from "../lib/jobs.js";

test("companion argument builders pin --cwd and forward options", () => {
  assert.deepEqual(reviewArgv({ cwd: "/repo", base: "main", scope: "branch", model: "m" }), [
    "review",
    "--cwd",
    "/repo",
    "--base",
    "main",
    "--scope",
    "branch",
    "--model",
    "m"
  ]);
  const adversarial = adversarialReviewArgv({ cwd: "/repo", jobId: "codex-1", focusFile: "/tmp/focus.txt" });
  assert.ok(adversarial.includes("--focus-file"));
  assert.ok(adversarial.includes("codex-1"));

  const task = taskArgv({
    cwd: "/repo",
    promptFile: "/tmp/prompt.txt",
    write: true,
    resumeLast: true,
    effort: "high",
    jobId: "codex-2"
  });
  assert.deepEqual(task, [
    "task",
    "--cwd",
    "/repo",
    "--prompt-file",
    "/tmp/prompt.txt",
    "--effort",
    "high",
    "--write",
    "--resume-last",
    "--job-id",
    "codex-2"
  ]);

  assert.deepEqual(statusArgv({ cwd: "/repo", jobId: "j1", all: true, wait: true, timeoutMs: 500 }), [
    "status",
    "--cwd",
    "/repo",
    "j1",
    "--all",
    "--wait",
    "--timeout-ms",
    "500"
  ]);
  assert.deepEqual(resultArgv({ cwd: "/repo" }), ["result", "--cwd", "/repo"]);
  assert.deepEqual(cancelArgv({ cwd: "/repo", jobId: "j1" }), ["cancel", "--cwd", "/repo", "j1"]);
  assert.deepEqual(setupArgv({ cwd: "/repo" }), ["setup", "--cwd", "/repo"]);
});

test("buildChildEnv injects the Harness session/id and prepends tool directories", () => {
  const env = buildChildEnv({
    node: { command: "/usr/bin/node", env: {} },
    codex: { command: "/opt/homebrew/bin/codex" },
    sessionId: "session-42",
    dataDir: "/tmp/codex-data",
    extraEnv: { EXTRA: "1" }
  });
  assert.equal(env.CODEX_COMPANION_SESSION_ID, "session-42");
  assert.equal(env.CODEX_COMPANION_DATA_DIR, "/tmp/codex-data");
  assert.equal(env.EXTRA, "1");
  assert.equal(env.PATH.split(path.delimiter)[0], "/opt/homebrew/bin");
  assert.equal(env.PATH.split(path.delimiter)[1], "/usr/bin");
});

test("buildChildEnv propagates ELECTRON_RUN_AS_NODE for Electron hosts", () => {
  const env = buildChildEnv({
    node: { command: "/app/DeepSeek Harness", env: { ELECTRON_RUN_AS_NODE: "1" } },
    codex: { command: "/opt/homebrew/bin/codex" },
    sessionId: null,
    dataDir: "/tmp/codex-data"
  });
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.CODEX_COMPANION_SESSION_ID, undefined);
});

test("resolveDataDir honours config and documented env overrides", () => {
  const original = { ...process.env };
  try {
    process.env.DSH_HOME = "/tmp/dsh-home";
    process.env.DSH_PROFILE = "desktop";
    assert.equal(resolveDataDir({ dataDir: "/tmp/explicit" }), "/tmp/explicit");
    // Profile-independent so the Desktop Host and the CLI share job records.
    assert.equal(resolveDataDir({}), "/tmp/dsh-home/codex-plugin-data");
    process.env.CODEX_PLUGIN_DATA_DIR = "~/codex-data";
    assert.equal(resolveDataDir({}), path.join(os.homedir(), "codex-data"));
    delete process.env.CODEX_PLUGIN_DATA_DIR;
  } finally {
    process.env = original;
  }
});

test("resolveNode returns the running node in a Node (non-Electron) process", () => {
  const node = resolveNode({});
  assert.ok(fs.existsSync(node.command), "resolved node exists");
  assert.match(node.source, /^node v\d+/);
});

test("resolveNode rejects an invalid explicit nodePath", () => {
  assert.throws(() => resolveNode({ nodePath: "/nonexistent/node" }), /not an executable/);
});

test("resolveCodex finds the installed CLI, rejects an invalid explicit path", () => {
  assert.throws(() => resolveCodex({ codexPath: "/nonexistent/codex" }), /not an executable/);
  const hasHomebrewCodex = fs.existsSync("/opt/homebrew/bin/codex");
  if (hasHomebrewCodex) {
    const codex = resolveCodex({});
    assert.equal(codex.command, "/opt/homebrew/bin/codex");
    assert.match(codex.source, /codex-cli/i);
  }
});

test("cleanOutput trims trailing whitespace and normalizes newlines", () => {
  assert.equal(cleanOutput("a\r\nb  \n\n"), "a\nb");
  assert.equal(cleanOutput("   "), "");
});

test("prompt files round-trip and clean up", () => {
  const file = writePromptFile("hello\nworld");
  try {
    assert.equal(fs.readFileSync(file, "utf8"), "hello\nworld");
  } finally {
    removePromptFile(file);
  }
  assert.equal(fs.existsSync(file), false);
});

test("chunksToText prefers stdout and falls back to stderr", () => {
  assert.equal(
    chunksToText([
      { text: "progress\n", channel: "stderr" },
      { text: "result\n", channel: "stdout" }
    ]),
    "result"
  );
  assert.equal(chunksToText([{ text: "error\n", channel: "stderr" }]), "error");
  assert.equal(chunksToText([]), "");
});

test("createRunner resolves lazily and caches the runtime", () => {
  const runner = createRunner({});
  let first;
  try {
    first = runner.ready();
  } catch (error) {
    if (/Codex CLI was not found/.test(String(error?.message ?? ""))) {
      // Hermetic: without an installed Codex CLI the data directory must still
      // be available even though execution resolution fails.
      assert.ok(runner.dataDir().length > 0);
      return;
    }
    throw error;
  }
  const second = runner.ready();
  assert.equal(first, second);
  assert.ok(first.node.command);
  assert.ok(first.codex.command);
  assert.ok(first.dataDir);
});
