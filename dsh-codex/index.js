/**
 * Codex plugin for DeepSeek Harness.
 *
 * Registers model-facing tools and human slash commands that drive the OpenAI
 * Codex CLI (through the vendored, DeepSeek-Harness-adapted codex-companion
 * runtime), plus prompt guidance and two embedded skills.
 *
 * Deliberately zero bare imports: the plugin talks only to Harness services
 * reached through `ctx`, so it needs no peerDependencies and stays loadable in
 * any profile. See README.md for the design and install notes.
 */
import fs from "node:fs";

import { createOperations } from "./lib/operations.js";
import { createRunner } from "./lib/runtime.js";

export const inject = ["tools", "workingDirectory"];

const PROMPT_SECTION = `## Codex delegation (OpenAI Codex CLI)

The local OpenAI Codex CLI is available through the \`codex_*\` tools. Use it when an
independent second pass adds real value: a code review before shipping, an adversarial
challenge to the current design, deep root-cause work, or a substantial implementation
task you want delegated. Do not delegate trivial work or work the user asked you to do
yourself, and never run Codex just to avoid a small task.

Tools:
- \`codex_review\`: read-only native Codex review of the working tree or \`base\` branch.
  It does not edit code. After presenting findings, ask the user which issues to fix
  before changing anything; never auto-apply review fixes.
- \`codex_adversarial_review\`: read-only, steerable challenge review of the chosen
  implementation/design, tradeoffs, and failure modes. Put the user's focus text in
  \`focus\`.
- \`codex_rescue\`: hand an investigation or implementation task to Codex. Set
  \`write: true\` only when edits are actually wanted; otherwise Codex stays read-only.
  Use \`resume_last\` to continue the previous Codex thread in this workspace, or
  \`fresh: true\` to force a new one. \`model\` and \`effort\` are optional.
- \`codex_status\` / \`codex_result\`: durable Codex job records for this workspace.
  \`codex_setup\`: Codex CLI/authentication readiness.

Communication contract (keeps you and Codex accurate and fast):
- Put options before task/focus text in slash commands; options after the first text
  token are literal text. Use \`--\` to force the rest to text.
- Pass \`cwd\` explicitly whenever the target differs from the session directory.
  Relative paths resolve against the session directory.
- Send Codex one self-contained task per run with the exact expected output. Do not
  ask it to re-derive what you can determine locally faster.
- A foreground result ends with the Codex thread id and resume command; use
  \`resume_last: true\` (or \`codex resume <id>\`) to continue that thread instead of
  starting a fresh one. Do not repeat an identical review.
- Long runs: pass \`background: true\` (recommended for anything larger than a tiny
  diff). You then receive a Harness background job id: read progress with
  \`job_output\`, the durable result and thread id with \`codex_result <id>\`, cancel
  with \`job_kill\`, and you are notified when it finishes. Do not poll or sleep on it.
- \`write: true\` lets Codex edit files. Model-initiated write runs require Harness
  approval (the session approval policy applies) and do not start when it is not
  granted; a human typing \`--write\` in a slash command is explicit consent. Set it
  only when the user asked for edits. If approval is refused, report that and offer a
  read-only run instead of retrying.
- Report Codex output faithfully: preserve verdict, findings order, file paths, and
  uncertainty markers. If a Codex run fails or is unauthenticated, say so and point
  the user at \`codex_setup\`; never invent a substitute Codex result.`;

const TOOL_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
    required: ["text"]
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

function textTool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      return run(args ?? {}, exec);
    }
  };
}

function createTools(operations) {
  const cwd = {
    type: "string",
    description: "Working directory (defaults to the session working directory)."
  };
  const background = {
    type: "boolean",
    description:
      "Run as a Harness background job and return a job id immediately (recommended for large reviews/tasks)."
  };
  const base = {
    type: "string",
    description: "Review changes against this git base branch/ref instead of the working tree."
  };
  const scope = {
    type: "string",
    enum: ["auto", "working-tree", "branch"],
    description: "What to review. `auto` detects the current working tree."
  };
  const model = {
    type: "string",
    description: "Optional Codex model id (for example gpt-5.3-codex-spark or a full model name)."
  };

  return [
    textTool(
      "codex_review",
      "Run OpenAI Codex's native, read-only code review against local git state (working tree or a base branch). " +
        "Returns Codex's review output plus the Codex thread id. It never edits code and must not be followed by " +
        "automatic fixes. Use background:true for anything larger than a tiny diff.",
      {
        type: "object",
        properties: { background, base, scope, model, cwd },
        additionalProperties: false
      },
      (args, exec) => operations.review(exec, args)
    ),
    textTool(
      "codex_adversarial_review",
      "Run a read-only, steerable OpenAI Codex review that challenges the implementation approach, design choices, " +
        "tradeoffs, and assumptions rather than only chasing implementation bugs. Pass the user's concern in `focus`. " +
        "Use background:true for long reviews.",
      {
        type: "object",
        properties: {
          background,
          base,
          scope,
          model,
          focus: {
            type: "string",
            description:
              "Optional focus text: the decision, risk area, or question Codex should challenge."
          },
          cwd
        },
        additionalProperties: false
      },
      (args, exec) => operations.adversarialReview(exec, args)
    ),
    textTool(
      "codex_rescue",
      "Delegate an investigation, diagnosis, or implementation task to OpenAI Codex in a persistent Codex thread. " +
        "Read-only unless write:true. Write runs are gated by Harness approval (session policy), so they do not " +
        "start unless the user allows them; use write:true only when the user asked for edits. Foreground results include " +
        "the Codex thread id for follow-ups; use resume_last (without a task) to continue the previous Codex thread " +
        "in this workspace, including from a new session. Prefer background:true for open-ended or long tasks.",
      {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "What Codex should investigate, diagnose, or implement."
          },
          background,
          write: {
            type: "boolean",
            description:
              "Allow Codex to modify files (workspace-write sandbox). Default false = read-only investigation."
          },
          resume_last: {
            type: "boolean",
            description: "Continue the previous Codex task thread in this workspace."
          },
          fresh: {
            type: "boolean",
            description: "Force a new Codex thread even if a previous one exists."
          },
          model,
          effort: {
            type: "string",
            enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
            description: "Optional Codex reasoning effort."
          },
          cwd
        },
        additionalProperties: false
      },
      (args, exec) => operations.rescue(exec, args)
    ),
    textTool(
      "codex_status",
      "Show active and recent Codex jobs for this workspace (optionally one job id). With a job id it returns that " +
        "job's durable status/output record; without one it lists the workspace's live and recent jobs. " +
        "wait:true waits for a specific job (timeout_ms, default 240000ms).",
      {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Optional Codex job id." },
          all: { type: "boolean", description: "Include older finished jobs." },
          wait: { type: "boolean", description: "Wait for a specific job to finish (needs job_id)." },
          timeout_ms: {
            type: "integer",
            description: "Wait bound in milliseconds when wait is true."
          },
          cwd
        },
        additionalProperties: false
      },
      (args, exec) => operations.status(exec, args)
    ),
    textTool(
      "codex_result",
      "Show the stored final output for a finished Codex job in this workspace (latest job when job_id is omitted).",
      {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Optional Codex job id." },
          cwd
        },
        additionalProperties: false
      },
      (args, exec) => operations.result(exec, args)
    ),
    textTool(
      "codex_setup",
      "Check whether the local Codex CLI is installed, authenticated, and able to use the app-server runtime. " +
        "Use before the first Codex run or when Codex reports an authentication/runtime problem. " +
        "Successful readiness checks are cached briefly; pass force:true to re-check immediately.",
      {
        type: "object",
        properties: {
          cwd,
          force: {
            type: "boolean",
            description: "Bypass the short readiness cache and re-check now."
          }
        },
        additionalProperties: false
      },
      (args, exec) => operations.setup(exec, args)
    )
  ];
}

/* ----------------------------- human commands ----------------------------- */

function readCommandValue(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  if (index >= text.length) {
    return { value: undefined, next: index };
  }
  const quote = text[index];
  if (quote === '"' || quote === "'") {
    index += 1;
    let value = "";
    while (index < text.length && text[index] !== quote) {
      if (text[index] === "\\" && index + 1 < text.length) {
        value += text[index + 1];
        index += 2;
      } else {
        value += text[index];
        index += 1;
      }
    }
    return { value, next: Math.min(index + 1, text.length) };
  }
  let value = "";
  while (index < text.length && !/\s/.test(text[index])) {
    if (text[index] === "\\" && index + 1 < text.length) {
      value += text[index + 1];
      index += 2;
    } else {
      value += text[index];
      index += 1;
    }
  }
  return { value, next: index };
}

/**
 * Parse a command's raw input without rewriting its literal text.
 *
 * Only the leading option prefix is parsed; the task/focus suffix is preserved
 * byte-for-byte (quotes included) from the first non-option token or after a
 * literal `--`. Flags after the text are therefore literal, which prevents a
 * task such as "explain the --write flag" from enabling writes, and a task such
 * as `Explain status === "failed"` keeps its quotes.
 */
export function parseCommandInput(rawInput, { valueFlags = [], boolFlags = [], hint = "" } = {}) {
  const text = String(rawInput ?? "");
  const flags = {};
  const supported = () => [
    ...valueFlags.map((flag) => `--${flag} <value>`),
    ...boolFlags.map((flag) => `--${flag}`)
  ];
  const usage = () => `${hint ? ` Usage: ${hint}.` : ""}`;
  let index = 0;
  let literal = null;

  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    if (!(text[index] === "-" && text[index + 1] === "-")) {
      literal = text.slice(index).trim();
      break;
    }
    if (index + 2 >= text.length || /\s/.test(text[index + 2])) {
      literal = text.slice(index + 2).trim();
      break;
    }
    index += 2;
    const nameMatch = /^[A-Za-z0-9_-]+/.exec(text.slice(index));
    if (!nameMatch) {
      literal = text.slice(Math.max(0, index - 2)).trim();
      break;
    }
    const name = nameMatch[0];
    index += name.length;
    const isValue = valueFlags.includes(name);
    const isBool = boolFlags.includes(name);
    if (!isValue && !isBool) {
      const options = supported();
      throw new Error(
        `Unknown option --${name}.${options.length ? ` Supported options: ${options.join(", ")}.` : ""}` +
          `${usage()} Put options before the task text, or use -- to pass text literally.`
      );
    }
    if (text[index] === "=") {
      const read = readCommandValue(text, index + 1);
      if (read.value === undefined) {
        throw new Error(`Option --${name} needs a value.${usage()}`);
      }
      flags[name] = isBool ? read.value !== "false" : read.value;
      index = read.next;
      continue;
    }
    if (!isValue) {
      flags[name] = true;
      continue;
    }
    const read = readCommandValue(text, index);
    if (read.value === undefined) {
      throw new Error(`Option --${name} needs a value.${usage()}`);
    }
    flags[name] = read.value;
    index = read.next;
  }

  return { flags, positionals: literal === null ? [] : [literal] };
}

function commandResult(text) {
  return { kind: "success", text };
}

function createCommands(operations) {
  function execFor(invocation) {
    // Commands are direct human actions: an explicit `--write` is once-only consent.
    return { agent: invocation.agent, signal: invocation.signal, fromCommand: true };
  }

  return [
    {
      name: "codex-review",
      description: "Run a read-only Codex review of the local git changes.",
      input: { hint: "[--background|--wait] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>]" },
      async handler(invocation) {
        const { flags } = parseCommandInput(invocation.rawInput, {
          valueFlags: ["base", "scope", "model"],
          boolFlags: ["background", "wait"],
          hint: "codex-review [--background|--wait] [--base <ref>] [--scope <scope>] [--model <id>]"
        });
        const result = await operations.review(execFor(invocation), {
          base: flags.base,
          scope: flags.scope,
          model: flags.model,
          background: Boolean(flags.background) && !flags.wait
        });
        return commandResult(result.text);
      }
    },
    {
      name: "codex-adversarial-review",
      description: "Run a read-only Codex review that challenges the current design and assumptions.",
      input: {
        hint: "[--background|--wait] [--base <ref>] [--scope <scope>] [--model <id>] [focus ...]"
      },
      async handler(invocation) {
        const { flags, positionals } = parseCommandInput(invocation.rawInput, {
          valueFlags: ["base", "scope", "model"],
          boolFlags: ["background", "wait"],
          hint: "codex-adversarial-review [flags] [focus text ...]"
        });
        const result = await operations.adversarialReview(execFor(invocation), {
          base: flags.base,
          scope: flags.scope,
          model: flags.model,
          focus: positionals.join(" "),
          background: Boolean(flags.background) && !flags.wait
        });
        return commandResult(result.text);
      }
    },
    {
      name: "codex-rescue",
      description: "Delegate an investigation or implementation task to Codex.",
      input: {
        hint: "[--background|--wait] [--write] [--resume-last|--fresh] [--model <id>] [--effort <effort>] [task ...]"
      },
      async handler(invocation) {
        const { flags, positionals } = parseCommandInput(invocation.rawInput, {
          valueFlags: ["model", "effort"],
          boolFlags: ["background", "wait", "write", "resume-last", "resume", "fresh"],
          hint: "codex-rescue [flags] [task ...]"
        });
        const result = await operations.rescue(execFor(invocation), {
          task: positionals.join(" "),
          write: Boolean(flags.write),
          resume_last: Boolean(flags["resume-last"] || flags.resume),
          fresh: Boolean(flags.fresh),
          model: flags.model,
          effort: flags.effort,
          background: Boolean(flags.background) && !flags.wait
        });
        return commandResult(result.text);
      }
    },
    {
      name: "codex-status",
      description: "Show active and recent Codex jobs for this workspace.",
      input: { hint: "[job-id] [--all] [--wait] [--timeout-ms <ms>]" },
      async handler(invocation) {
        const { flags, positionals } = parseCommandInput(invocation.rawInput, {
          valueFlags: ["timeout-ms"],
          boolFlags: ["all", "wait"],
          hint: "codex-status [job-id] [--all] [--wait] [--timeout-ms <ms>]"
        });
        const result = await operations.status(execFor(invocation), {
          job_id: positionals[0],
          all: Boolean(flags.all),
          wait: Boolean(flags.wait),
          timeout_ms: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined
        });
        return commandResult(result.text);
      }
    },
    {
      name: "codex-result",
      description: "Show the stored final output for a finished Codex job.",
      input: { hint: "[job-id]" },
      async handler(invocation) {
        const { positionals } = parseCommandInput(invocation.rawInput);
        const result = await operations.result(execFor(invocation), { job_id: positionals[0] });
        return commandResult(result.text);
      }
    },
    {
      name: "codex-cancel",
      description: "Cancel the active Codex job in this workspace.",
      input: { hint: "[job-id]" },
      async handler(invocation) {
        const { positionals } = parseCommandInput(invocation.rawInput);
        const result = await operations.cancel(execFor(invocation), { job_id: positionals[0] });
        return commandResult(result.text);
      }
    },
    {
      name: "codex-setup",
      description: "Check Codex CLI installation and authentication readiness (--force re-checks past the cache).",
      input: { hint: "[--force]" },
      async handler(invocation) {
        const { flags } = parseCommandInput(invocation.rawInput, {
          boolFlags: ["force"],
          hint: "codex-setup [--force]"
        });
        const result = await operations.setup(execFor(invocation), { force: Boolean(flags.force) });
        return commandResult(result.text);
      }
    }
  ];
}

/* --------------------------------- skills --------------------------------- */

const SKILL_FILES = ["codex-delegation.md", "codex-result-handling.md"];

function parseSkillDocument(file, content) {
  const fallbackName = file.replace(/\.md$/, "");
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!frontmatter) {
    return { name: fallbackName, description: `Codex reference guidance: ${fallbackName}`, content };
  }
  const meta = {};
  for (const line of frontmatter[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  const name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name ?? "") ? meta.name : fallbackName;
  return {
    name,
    description: meta.description || `Codex reference guidance: ${fallbackName}`,
    content: content.slice(frontmatter[0].length).trim()
  };
}

function loadSkills() {
  const skills = [];
  for (const entry of SKILL_FILES) {
    try {
      const content = fs.readFileSync(new URL(`./skills/${entry}`, import.meta.url), "utf8");
      const skill = parseSkillDocument(entry, content);
      skills.push({
        ...skill,
        source: "codex-plugin",
        invocation: { modelInvocable: true, userInvocable: true }
      });
    } catch {
      // A missing optional skill file must not disable the plugin.
    }
  }
  return skills;
}

export function apply(ctx, config = {}) {
  const runner = createRunner(config ?? {});
  const operations = createOperations({ ctx, runner, config: config ?? {} });

  for (const tool of createTools(operations)) {
    ctx.tools.register(tool);
  }

  ctx.inject(["commands"], (commandsCtx) => {
    for (const command of createCommands(operations)) {
      commandsCtx.commands.register(command);
    }
  });

  ctx.inject(["systemPrompt"], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: "codex-plugin",
      order: 2500,
      text: PROMPT_SECTION
    });
  });

  ctx.inject(["skills"], (skillsCtx) => {
    for (const skill of loadSkills()) {
      skillsCtx.skills.register(skill);
    }
  });
}
