import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";

import { apply, inject as hardInject } from "../index.js";
import { createFakeCtx } from "./fakes.mjs";

function loadPlugin(config = {}) {
  const fake = createFakeCtx();
  apply(fake.ctx, config);
  const byName = (name) => fake.tools.find((tool) => tool.name === name);
  return { ...fake, byName };
}

const fakeExec = {
  agent: { id: "session-1", session: { id: "session-1" } },
  callId: "call-1",
  rootCallId: "call-1",
  signal: new AbortController().signal,
  deferContext() {},
  concludeTurn() {}
};

test("plugin hard-requires only tools and workingDirectory", () => {
  assert.deepEqual(hardInject, ["tools", "workingDirectory"]);
});

test("registers the six Codex tools with valid raw ToolDefinition shapes", () => {
  const plugin = loadPlugin();
  const names = plugin.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "codex_adversarial_review",
    "codex_rescue",
    "codex_result",
    "codex_review",
    "codex_setup",
    "codex_status"
  ]);

  for (const tool of plugin.tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.output.schema.type, "object");
    assert.equal(typeof tool.output.render, "function");
    assert.deepEqual(tool.output.render({}, { text: "hi" }), [{ type: "text", text: "hi" }]);
  }
});

test("review tool parameters expose the documented controls", () => {
  const plugin = loadPlugin();
  const properties = plugin.byName("codex_review").parameters.properties;
  for (const key of ["background", "base", "scope", "model", "cwd"]) {
    assert.ok(properties[key], `codex_review exposes ${key}`);
  }
  assert.deepEqual(properties.scope.enum, ["auto", "working-tree", "branch"]);
});

test("registers human commands with unique lowercase names", () => {
  const plugin = loadPlugin();
  const names = plugin.commands.map((command) => command.name);
  assert.deepEqual(names.sort(), [
    "codex-adversarial-review",
    "codex-cancel",
    "codex-rescue",
    "codex-result",
    "codex-review",
    "codex-setup",
    "codex-status"
  ]);
  assert.equal(new Set(names).size, names.length);
  for (const command of plugin.commands) {
    assert.match(command.name, /^[a-z0-9][a-z0-9-]*$/);
    assert.equal(typeof command.description, "string");
    assert.equal(typeof command.handler, "function");
  }
});

test("registers one prompt section with Codex guidance", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.sections.length, 1);
  const section = plugin.sections[0];
  assert.equal(section.name, "codex-plugin");
  assert.equal(section.order, 2500);
  assert.match(section.text, /codex_review/);
  assert.match(section.text, /background/);
  assert.match(section.text, /never auto-apply review fixes/i);
});

test("registers two embedded skills without frontmatter noise", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.skills.length, 2);
  const names = plugin.skills.map((skill) => skill.name).sort();
  assert.deepEqual(names, ["codex-delegation", "codex-result-handling"]);
  for (const skill of plugin.skills) {
    assert.ok(skill.description.length > 10, `${skill.name} has a description`);
    assert.equal(skill.source, "codex-plugin");
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
    assert.equal(skill.content.startsWith("---"), false, "frontmatter stripped");
    assert.ok(skill.content.includes("#"), "markdown body preserved");
  }
});

test("commands reject a missing Codex CLI with actionable guidance when executed", async () => {
  const plugin = loadPlugin({ codexPath: "/nonexistent/codex-binary" });
  const setup = plugin.commands.find((command) => command.name === "codex-setup");
  await assert.rejects(
    () =>
      setup.handler({
        commandId: "cmd-1",
        agent: fakeExec.agent,
        rawInput: "",
        attachments: [],
        signal: new AbortController().signal
      }),
    /not an executable file/
  );
});

test("background review fails clearly when the jobs service is absent", async () => {
  const plugin = loadPlugin();
  const review = plugin.byName("codex_review");
  await assert.rejects(
    () => review.execute({ background: true }, fakeExec),
    /background-job service/
  );
});
