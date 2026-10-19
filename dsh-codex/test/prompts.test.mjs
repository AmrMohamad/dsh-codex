/**
 * Prompt and result contracts between the DeepSeek Harness agent and Codex.
 * See docs/PROMPTS.md. These tests keep the envelope, schema, renderer, and the
 * DeepSeek-facing docs (tool descriptions, prompt section, skills) in sync.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { PROMPT_SECTION } from "../lib/prompt.js";
import { createTools } from "../lib/tools.js";
import { buildAdversarialReviewPrompt, buildTaskPrompt } from "../runtime/scripts/lib/prompts.mjs";
import {
  firstMeaningfulLine,
  renderNativeReviewResult,
  renderReviewResult,
  renderTaskResult
} from "../runtime/scripts/lib/render.mjs";

const REPORT_HEADINGS = [
  "## Outcome",
  "## Details",
  "## Changes",
  "## Verification",
  "## Risks and open questions",
  "## Next steps"
];

const readText = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const schema = JSON.parse(readText("../runtime/schemas/review-output.schema.json"));

/* ------------------------------ task envelope ------------------------------ */

test("task envelope carries the brief verbatim plus the report contract", () => {
  const brief = 'Goal: fix paginate().\nContext: `npm test` says "expected 11, got 1". Keep $& and {{TASK}} literal.';
  const prompt = buildTaskPrompt({ task: brief });
  assert.ok(prompt.includes(`<task>\n${brief}\n</task>`), "brief is inserted unchanged");
  assert.doesNotMatch(prompt.replace(brief, ""), /\{\{[A-Z_]+\}\}/, "no unresolved placeholders");

  let cursor = -1;
  for (const heading of REPORT_HEADINGS) {
    const at = prompt.indexOf(`\n${heading}\n`);
    assert.ok(at > cursor, `${heading} appears once, in order`);
    cursor = at;
  }
  assert.match(prompt, /Status: <done \| partial \| blocked>/);
  // Official Codex guidance: asking for upfront plans or preambles makes it stop early.
  assert.doesNotMatch(prompt, /\b(upfront plan|preamble|progress update)/i);
});

test("task envelope access rules follow the write flag", () => {
  const readOnly = buildTaskPrompt({ task: "Investigate" });
  const write = buildTaskPrompt({ task: "Fix", write: true });
  assert.match(readOnly, /This run is read-only/);
  assert.match(readOnly, /exact diff/);
  assert.doesNotMatch(readOnly, /may edit files/);
  assert.match(write, /This run may edit files/);
  assert.match(write, /Do not commit, push or create branches/);
  assert.doesNotMatch(write, /This run is read-only/);
});

test("task summaries come from the Status line, not the report heading", () => {
  const report = "## Outcome\nStatus: done — Fixed the off-by-one in paginate().\n\n## Details\n- x";
  assert.equal(firstMeaningfulLine(report, "fallback"), "Status: done — Fixed the off-by-one in paginate().");
  assert.equal(firstMeaningfulLine("", "fallback"), "fallback");
  assert.equal(firstMeaningfulLine("plain answer\nmore", "fallback"), "plain answer");
});

test("task results mark edited files as observed, not claimed", () => {
  const text = renderTaskResult({ rawOutput: "## Outcome\nStatus: done — ok" }, { touchedFiles: ["src/a.js"], write: true });
  assert.match(text, /Files Codex edited \(observed\):\n- src\/a\.js/);
});

/* --------------------------- adversarial contract -------------------------- */

function assertStrictObjects(node, at = "$") {
  if (node?.type === "object") {
    assert.equal(node.additionalProperties, false, `${at} forbids extra keys`);
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${at} requires every key`);
    for (const [key, child] of Object.entries(node.properties)) {
      assertStrictObjects(child, `${at}.${key}`);
    }
  }
  if (node?.type === "array") {
    assertStrictObjects(node.items, `${at}[]`);
  }
}

test("review schema stays strict-mode compatible and reasoning-first", () => {
  assertStrictObjects(schema);
  const findingKeys = Object.keys(schema.properties.findings.items.properties);
  assert.equal(findingKeys.at(-1), "confidence", "confidence is scored after the evidence");
  const topKeys = Object.keys(schema.properties);
  assert.ok(topKeys.indexOf("findings") < topKeys.indexOf("verdict"), "verdict follows the findings");
});

test("adversarial prompt explains every schema field and both scales", () => {
  const context = {
    target: { label: "working tree diff" },
    collectionGuidance: "Use the repository context below as primary evidence.",
    content: "## Git Status\n\n M src/a.js"
  };
  const prompt = buildAdversarialReviewPrompt(context, "");
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
  assert.match(prompt, /User focus: No extra focus provided\./);
  assert.match(prompt, /<severity_scale>[\s\S]*critical:[\s\S]*high:[\s\S]*medium:[\s\S]*low:/);
  assert.match(prompt, /<confidence_scale>/);
  const fields = [...Object.keys(schema.properties), ...Object.keys(schema.properties.findings.items.properties)];
  for (const field of fields) {
    assert.ok(prompt.includes(field), `prompt explains \`${field}\``);
  }
});

test("adversarial findings render with ids, confidence, scenario, fix and verify", () => {
  const parsed = {
    findings: [
      { severity: "medium", title: "Cap retries", file: "src/q.js", line_start: 40, line_end: 44,
        failure_scenario: "503 loop", body: "No cap.", recommendation: "Cap at 5.", verification: "Stub 503.", confidence: 0.7 },
      { severity: "high", title: "Lock writes", file: "src/db.js", line_start: 12, line_end: 12,
        failure_scenario: "Lost update", body: "Read-modify-write.", recommendation: "Use a transaction.",
        verification: "Concurrent test.", confidence: 0.6 },
      { severity: "high", title: "Check auth", file: "src/auth.js", line_start: 3, line_end: 5,
        failure_scenario: "Anonymous write", body: "Guard skipped.", recommendation: "Call requireUser().",
        verification: "401 test.", confidence: 0.95 }
    ],
    residual_risks: ["Integration tests not run."],
    verdict: "needs-attention",
    summary: "Do not ship.",
    next_steps: ["Fix F1.", "Fix F2."]
  };
  const text = renderReviewResult({ parsed }, { reviewLabel: "Adversarial Review", targetLabel: "working tree diff" });
  assert.match(text, /Verdict: needs-attention \(3 findings: 2 high, 1 medium\)/);
  // Severity first, then confidence.
  assert.match(text, /### F1 · high · confidence 0\.95 — Check auth\nLocation: `src\/auth\.js:3-5`\nScenario: Anonymous write/);
  assert.match(text, /### F2 · high · confidence 0\.60 — Lock writes/);
  assert.match(text, /### F3 · medium · confidence 0\.70 — Cap retries[\s\S]*Fix: Cap at 5\.\nVerify: Stub 503\./);
  assert.match(text, /## Residual risks\n\n- Integration tests not run\./);
  assert.match(text, /## Next steps\n\n1\. Fix F1\.\n2\. Fix F2\./);
});

test("review records stored before the richer schema still render", () => {
  const legacy = {
    verdict: "approve",
    summary: "Looks safe.",
    findings: [{ severity: "low", title: "Old", body: "b", file: "f.js", line_start: 1, line_end: 1, recommendation: "r" }],
    next_steps: []
  };
  const text = renderReviewResult({ parsed: legacy }, { reviewLabel: "Adversarial Review", targetLabel: "branch" });
  assert.match(text, /### F1 · low — Old\nLocation: `f\.js:1`\nWhy: b\nFix: r/);
  assert.doesNotMatch(text, /Residual risks|Scenario:|Verify:/);
});

test("native review output gets a priority legend only when it uses priorities", () => {
  const meta = { reviewLabel: "Review", targetLabel: "working tree diff" };
  const tagged = renderNativeReviewResult({ status: 0, stdout: "- [P1] Fix it — src/a.js:3-3", stderr: "" }, meta);
  assert.match(tagged, /Priorities: \[P0\] blocks release/);
  const plain = renderNativeReviewResult({ status: 0, stdout: "No issues found.", stderr: "" }, meta);
  assert.doesNotMatch(plain, /Priorities:/);
});

/* ------------------- DeepSeek-facing docs match the contract ------------------- */

test("tool description, prompt section and skills describe the same report", () => {
  const rescue = createTools({}).find((tool) => tool.name === "codex_rescue");
  const handling = readText("../skills/codex-result-handling.md");
  for (const heading of REPORT_HEADINGS) {
    const name = heading.slice(3);
    assert.ok(rescue.description.includes(name.split(" ")[0]), `codex_rescue mentions ${name}`);
    assert.ok(handling.includes(heading), `result-handling skill explains ${heading}`);
  }
  assert.match(rescue.parameters.properties.task.description, /goal[\s\S]*context[\s\S]*constraints[\s\S]*done/i);
  assert.match(PROMPT_SECTION, /report format is added for you/);
  const delegation = readText("../skills/codex-delegation.md");
  assert.match(delegation, /Goal:[\s\S]*Context:[\s\S]*Constraints:[\s\S]*Done when:/);
  assert.doesNotMatch(delegation, /output_contract/, "the envelope owns the report format");
});
