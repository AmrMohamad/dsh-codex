/**
 * Codex plugin for DeepSeek Harness — entry point.
 *
 * Registers model-facing tools, human slash commands, a system-prompt section,
 * and two embedded skills. All of them drive the OpenAI Codex CLI through the
 * vendored codex-companion runtime (runtime/).
 *
 * Deliberately zero bare imports: the plugin talks only to Harness services
 * reached through `ctx`, so it needs no peerDependencies and stays loadable in
 * any profile. Module map and invariants: ../AGENTS.md.
 */
import { createCommands } from "./lib/commands.js";
import { createOperations } from "./lib/operations.js";
import { PROMPT_SECTION } from "./lib/prompt.js";
import { createRunner } from "./lib/runtime.js";
import { loadSkills } from "./lib/skills.js";
import { createTools } from "./lib/tools.js";

export { parseCommandInput } from "./lib/commands.js";

export const inject = ["tools", "workingDirectory"];

export function apply(ctx, config = {}) {
  const pluginConfig = config ?? {};
  const runner = createRunner(pluginConfig);
  const operations = createOperations({ ctx, runner, config: pluginConfig });

  for (const tool of createTools(operations)) {
    ctx.tools.register(tool);
  }

  ctx.inject(["commands"], (commandsCtx) => {
    for (const command of createCommands(operations)) {
      commandsCtx.commands.register(command);
    }
  });

  ctx.inject(["systemPrompt"], (promptCtx) => {
    promptCtx.systemPrompt.section({ name: "codex-plugin", order: 2500, text: PROMPT_SECTION });
  });

  ctx.inject(["skills"], (skillsCtx) => {
    for (const skill of loadSkills()) {
      skillsCtx.skills.register(skill);
    }
  });
}
