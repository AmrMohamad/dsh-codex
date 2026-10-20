/**
 * End-to-end: the real companion CLI, its broker, and a fake `codex app-server`
 * (test/fixtures/fake-codex.mjs). Proves what actually reaches Codex (the task
 * envelope, the sandbox, the review output schema) and what comes back to the
 * Harness agent, without a Codex install. POSIX only (the broker uses a unix
 * socket and the fake is a shebang script).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const COMPANION = fileURLToPath(new URL("../runtime/scripts/codex-companion.mjs", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const SKIP = process.platform === "win32" || spawnSync("git", ["--version"]).status !== 0;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-codex-e2e-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...args) =>
    spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd: repo });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "app.js"), "export const page = (n) => n * 10;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return { root, repo, dataDir: path.join(root, "data"), log: path.join(root, "requests.jsonl") };
}

function runCompanion(env, args, reply) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      CODEX_COMPANION_CODEX_BIN: FAKE_CODEX,
      CODEX_COMPANION_DATA_DIR: env.dataDir,
      CODEX_COMPANION_BROKER_IDLE_MS: "1500",
      FAKE_CODEX_LOG: env.log,
      FAKE_CODEX_REPLY: reply
    }
  });
}

function requests(env, method) {
  return fs
    .readFileSync(env.log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.method === method);
}

/** Stop the broker this test started instead of waiting for its idle reaper. */
function stopBroker(env) {
  const stateRoot = path.join(env.dataDir, "state");
  for (const dir of fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot) : []) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(stateRoot, dir, "broker.json"), "utf8"));
      process.kill(-pid, "SIGTERM");
    } catch {
      // No broker, or it already exited.
    }
  }
}

function storedSummaries(env) {
  const stateRoot = path.join(env.dataDir, "state");
  return fs
    .readdirSync(stateRoot)
    .flatMap((dir) => JSON.parse(fs.readFileSync(path.join(stateRoot, dir, "state.json"), "utf8")).jobs ?? [])
    .map((job) => job.summary);
}

const REPORT = [
  "## Outcome",
  "Status: done — page() multiplies by n instead of n - 1.",
  "",
  "## Details",
  "- `app.js:1` computes the offset from the 1-based page number."
].join("\n");

test("a read-only task reaches Codex inside the envelope and returns its report", { skip: SKIP }, () => {
  const env = setup();
  try {
    const brief = path.join(env.root, "brief.txt");
    fs.writeFileSync(brief, "Goal: explain why page 2 repeats page 1.\nContext: see app.js.");
    const result = runCompanion(env, ["task", "--cwd", env.repo, "--prompt-file", brief], REPORT);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(REPORT), "the report reaches the Harness agent unchanged");

    const [threadStart] = requests(env, "thread/start");
    assert.equal(threadStart.params.sandbox, "read-only");
    const [nameSet] = requests(env, "thread/name/set");
    assert.match(nameSet.params.name, /Goal: explain why page 2 repeats page 1/, "thread name uses the raw brief");
    const [turn] = requests(env, "turn/start");
    const sent = turn.params.input[0].text;
    assert.ok(sent.startsWith("<task>\nGoal: explain why page 2 repeats page 1.\nContext: see app.js.\n</task>"));
    assert.match(sent, /This run is read-only/);
    assert.match(sent, /<report_contract>[\s\S]*## Outcome[\s\S]*## Next steps/);

    assert.deepEqual(storedSummaries(env), ["Status: done — page() multiplies by n instead of n - 1."]);
  } finally {
    stopBroker(env);
  }
});

test("a write task asks Codex for workspace-write and the write rules", { skip: SKIP }, () => {
  const env = setup();
  try {
    const brief = path.join(env.root, "brief.txt");
    fs.writeFileSync(brief, "Goal: fix page().");
    const result = runCompanion(env, ["task", "--cwd", env.repo, "--prompt-file", brief, "--write"], REPORT);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests(env, "thread/start")[0].params.sandbox, "workspace-write");
    const sent = requests(env, "turn/start")[0].params.input[0].text;
    assert.match(sent, /This run may edit files/);
    assert.doesNotMatch(sent, /This run is read-only/);
  } finally {
    stopBroker(env);
  }
});

test("an adversarial review sends the schema and renders actionable findings", { skip: SKIP }, () => {
  const env = setup();
  try {
    fs.writeFileSync(path.join(env.repo, "app.js"), "export const page = (n) => n * 10 + 1;\n");
    const reply = JSON.stringify({
      findings: [
        {
          severity: "high",
          title: "Restore zero-based offsets",
          file: "app.js",
          line_start: 1,
          line_end: 1,
          failure_scenario: "page(0) returns 1, so the first record is skipped.",
          body: "The +1 shifts every page (app.js:1).",
          recommendation: "Return n * 10.",
          verification: "Assert page(0) === 0.",
          confidence: 0.9
        }
      ],
      residual_risks: ["Callers were not visible."],
      verdict: "needs-attention",
      summary: "Do not ship: every page skips one record.",
      next_steps: ["Fix F1."]
    });
    const result = runCompanion(env, ["adversarial-review", "--cwd", env.repo, "--scope", "working-tree"], reply);
    assert.equal(result.status, 0, result.stderr);

    const [turn] = requests(env, "turn/start");
    const schema = JSON.parse(
      fs.readFileSync(new URL("../runtime/schemas/review-output.schema.json", import.meta.url), "utf8")
    );
    assert.deepEqual(turn.params.outputSchema, schema, "the current schema is what Codex must follow");
    assert.match(turn.params.input[0].text, /<severity_scale>[\s\S]*<confidence_scale>/);

    assert.match(result.stdout, /Verdict: needs-attention \(1 finding: 1 high\)/);
    assert.match(result.stdout, /### F1 · high · confidence 0\.90 — Restore zero-based offsets/);
    assert.match(result.stdout, /Scenario: page\(0\) returns 1/);
    assert.match(result.stdout, /Verify: Assert page\(0\) === 0\./);
    assert.match(result.stdout, /## Residual risks\n\n- Callers were not visible\./);
  } finally {
    stopBroker(env);
  }
});
