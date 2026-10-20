/**
 * Human slash commands (`/codex-*`). Each command parses its raw input and
 * calls the same operation as the matching tool, so commands and tools can
 * never drift apart in behavior.
 *
 * A command is a direct human action: `--write` typed by a person is explicit,
 * once-only consent (operations.js skips the approval prompt for it).
 */

function readCommandValue(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  if (index >= text.length) {
    return { value: undefined, next: index };
  }
  const quote = text[index];
  const quoted = quote === '"' || quote === "'";
  if (quoted) {
    index += 1;
  }
  const atEnd = (i) => (quoted ? text[i] === quote : /\s/.test(text[i]));
  let value = "";
  while (index < text.length && !atEnd(index)) {
    if (text[index] === "\\" && index + 1 < text.length) {
      value += text[index + 1];
      index += 2;
    } else {
      value += text[index];
      index += 1;
    }
  }
  return { value, next: quoted ? Math.min(index + 1, text.length) : index };
}

/**
 * Parse a command's raw input without rewriting its literal text.
 *
 * Only the leading option prefix is parsed; the task/focus suffix is preserved
 * byte-for-byte (quotes included) from the first non-option token or after a
 * literal `--`. Flags after the text are therefore literal, which prevents a
 * task such as "explain the --write flag" from enabling writes, and a task such
 * as `Explain status === "failed"` keeps its quotes.
 *
 * @param {string} rawInput
 * @param {{ valueFlags?: string[]; boolFlags?: string[]; hint?: string }} [options]
 * @returns {{ flags: Record<string, string | boolean>; positionals: string[] }}
 */
export function parseCommandInput(rawInput, { valueFlags = [], boolFlags = [], hint = "" } = {}) {
  const text = String(rawInput ?? "");
  const flags = {};
  const usage = hint ? ` Usage: ${hint}.` : "";
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
      const supported = [...valueFlags.map((flag) => `--${flag} <value>`), ...boolFlags.map((flag) => `--${flag}`)];
      throw new Error(
        `Unknown option --${name}.${supported.length ? ` Supported options: ${supported.join(", ")}.` : ""}` +
          `${usage} Put options before the task text, or use -- to pass text literally.`
      );
    }
    if (text[index] === "=") {
      const read = readCommandValue(text, index + 1);
      if (read.value === undefined) {
        throw new Error(`Option --${name} needs a value.${usage}`);
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
      throw new Error(`Option --${name} needs a value.${usage}`);
    }
    flags[name] = read.value;
    index = read.next;
  }

  return { flags, positionals: literal === null ? [] : [literal] };
}

/** `--background` runs in the background unless `--wait` also appears. */
function runInBackground(flags) {
  return Boolean(flags.background) && !flags.wait;
}

/**
 * @param {{ name: string; description: string; usage: string; valueFlags?: string[]; boolFlags?: string[];
 *   run: (exec: any, parsed: { flags: Record<string, any>; text: string }) => Promise<{ text: string }> }} spec
 */
function defineCommand(spec) {
  return {
    name: spec.name,
    description: spec.description,
    input: { hint: spec.usage },
    async handler(invocation) {
      const { flags, positionals } = parseCommandInput(invocation.rawInput, {
        valueFlags: spec.valueFlags,
        boolFlags: spec.boolFlags,
        hint: `${spec.name} ${spec.usage}`
      });
      const exec = { agent: invocation.agent, signal: invocation.signal, fromCommand: true };
      const result = await spec.run(exec, { flags, text: positionals.join(" ") });
      return { kind: "success", text: result.text };
    }
  };
}

/** @param {ReturnType<import("./operations.js").createOperations>} operations */
export function createCommands(operations) {
  return [
    defineCommand({
      name: "codex-review",
      description: "Run a read-only Codex review of the local git changes.",
      usage: "[--background|--wait] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>]",
      valueFlags: ["base", "scope", "model"],
      boolFlags: ["background", "wait"],
      run: (exec, { flags }) =>
        operations.review(exec, {
          base: flags.base,
          scope: flags.scope,
          model: flags.model,
          background: runInBackground(flags)
        })
    }),
    defineCommand({
      name: "codex-adversarial-review",
      description: "Run a read-only Codex review that challenges the current design and assumptions.",
      usage: "[--background|--wait] [--base <ref>] [--scope <scope>] [--model <id>] [focus ...]",
      valueFlags: ["base", "scope", "model"],
      boolFlags: ["background", "wait"],
      run: (exec, { flags, text }) =>
        operations.adversarialReview(exec, {
          base: flags.base,
          scope: flags.scope,
          model: flags.model,
          focus: text,
          background: runInBackground(flags)
        })
    }),
    defineCommand({
      name: "codex-rescue",
      description: "Delegate an investigation or implementation task to Codex.",
      usage: "[--background|--wait] [--write] [--resume-last|--fresh] [--model <id>] [--effort <effort>] [task ...]",
      valueFlags: ["model", "effort"],
      boolFlags: ["background", "wait", "write", "resume-last", "resume", "fresh"],
      run: (exec, { flags, text }) =>
        operations.rescue(exec, {
          task: text,
          write: Boolean(flags.write),
          resume_last: Boolean(flags["resume-last"] || flags.resume),
          fresh: Boolean(flags.fresh),
          model: flags.model,
          effort: flags.effort,
          background: runInBackground(flags)
        })
    }),
    defineCommand({
      name: "codex-status",
      description: "Show active and recent Codex jobs for this workspace.",
      usage: "[--all] [--wait] [--timeout-ms <ms>] [job-id]",
      valueFlags: ["timeout-ms"],
      boolFlags: ["all", "wait"],
      run: (exec, { flags, text }) =>
        operations.status(exec, {
          job_id: text || undefined,
          all: Boolean(flags.all),
          wait: Boolean(flags.wait),
          timeout_ms: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined
        })
    }),
    defineCommand({
      name: "codex-result",
      description: "Show the stored final output for a finished Codex job.",
      usage: "[job-id]",
      run: (exec, { text }) => operations.result(exec, { job_id: text || undefined })
    }),
    defineCommand({
      name: "codex-cancel",
      description: "Cancel the active Codex job in this workspace.",
      usage: "[job-id]",
      run: (exec, { text }) => operations.cancel(exec, { job_id: text || undefined })
    }),
    defineCommand({
      name: "codex-setup",
      description: "Check Codex CLI installation and authentication readiness (--force re-checks past the cache).",
      usage: "[--force]",
      boolFlags: ["force"],
      run: (exec, { flags }) => operations.setup(exec, { force: Boolean(flags.force) })
    })
  ];
}
