/**
 * Model-facing tool definitions (raw Harness ToolDefinitions, no imports from
 * Harness packages). A tool only declares its schema; it forwards arguments to
 * the matching operation in operations.js, which validates them and returns
 * `{ text }`.
 *
 * Descriptions are prompts: they tell the model when to use a tool and what
 * must never follow it (for example, no automatic fixes after a review).
 */

const TOOL_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
    required: ["text"]
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};

function textTool(name, description, properties, run) {
  return {
    name,
    description,
    parameters: { type: "object", properties, additionalProperties: false },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      return run(args ?? {}, exec);
    }
  };
}

/* Shared parameter schemas. */
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
const jobId = { type: "string", description: "Optional Codex job id." };

/** @param {ReturnType<import("./operations.js").createOperations>} operations */
export function createTools(operations) {
  return [
    textTool(
      "codex_review",
      "Run OpenAI Codex's native, read-only code review against local git state (working tree or a base branch). " +
        "Returns Codex's review output plus the Codex thread id. It never edits code and must not be followed by " +
        "automatic fixes. Use background:true for anything larger than a tiny diff.",
      { background, base, scope, model, cwd },
      (args, exec) => operations.review(exec, args)
    ),
    textTool(
      "codex_adversarial_review",
      "Run a read-only, steerable OpenAI Codex review that challenges the implementation approach, design choices, " +
        "tradeoffs, and assumptions rather than only chasing implementation bugs. Pass the user's concern in `focus`. " +
        "Returns a verdict and findings F1..Fn, each with severity, confidence, location, failure scenario, fix and a " +
        "verification test, plus residual risks and next steps. Use background:true for long reviews.",
      {
        background,
        base,
        scope,
        model,
        focus: {
          type: "string",
          description:
            "Optional focus: the decision, risk area, or question Codex should challenge, plus context it cannot " +
            "see in the repository (requirements, expected load, constraints the design must keep)."
        },
        cwd
      },
      (args, exec) => operations.adversarialReview(exec, args)
    ),
    textTool(
      "codex_rescue",
      "Delegate an investigation, diagnosis, or implementation task to OpenAI Codex in a persistent Codex thread. " +
        "Read-only unless write:true. Write runs are gated by Harness approval (session policy), so they do not " +
        "start unless the user allows them; use write:true only when the user asked for edits. Foreground results include " +
        "the Codex thread id for follow-ups; use resume_last (without a task) to continue the previous Codex thread " +
        "in this workspace, including from a new session. Prefer background:true for open-ended or long tasks. " +
        "Codex answers with a handoff report: Outcome (Status: done | partial | blocked), Details, Changes (edits made, " +
        "or exact diffs on read-only runs), Verification, Risks and open questions, Next steps.",
      {
        task: {
          type: "string",
          description:
            "The brief for Codex, which has not seen this conversation: the goal; context it cannot find quickly " +
            "(relevant files, the exact error or failing output, what you already tried or ruled out); constraints; " +
            "and what done looks like. The report format is added automatically; do not specify one. For " +
            "resume_last, send only the new instruction."
        },
        background,
        write: {
          type: "boolean",
          description: "Allow Codex to modify files (workspace-write sandbox). Default false = read-only investigation."
        },
        resume_last: { type: "boolean", description: "Continue the previous Codex task thread in this workspace." },
        fresh: { type: "boolean", description: "Force a new Codex thread even if a previous one exists." },
        model,
        effort: {
          type: "string",
          enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
          description: "Optional Codex reasoning effort."
        },
        cwd
      },
      (args, exec) => operations.rescue(exec, args)
    ),
    textTool(
      "codex_status",
      "Show active and recent Codex jobs for this workspace (optionally one job id). With a job id it returns that " +
        "job's durable status/output record; without one it lists the workspace's live and recent jobs. " +
        "wait:true waits for a specific job (timeout_ms, default 240000ms).",
      {
        job_id: jobId,
        all: { type: "boolean", description: "Include older finished jobs." },
        wait: { type: "boolean", description: "Wait for a specific job to finish (needs job_id)." },
        timeout_ms: { type: "integer", description: "Wait bound in milliseconds when wait is true." },
        cwd
      },
      (args, exec) => operations.status(exec, args)
    ),
    textTool(
      "codex_result",
      "Show the stored final output for a finished Codex job in this workspace (latest job when job_id is omitted).",
      { job_id: jobId, cwd },
      (args, exec) => operations.result(exec, args)
    ),
    textTool(
      "codex_setup",
      "Check whether the local Codex CLI is installed, authenticated, and able to use the app-server runtime. " +
        "Use before the first Codex run or when Codex reports an authentication/runtime problem. " +
        "Successful readiness checks are cached briefly; pass force:true to re-check immediately.",
      {
        cwd,
        force: { type: "boolean", description: "Bypass the short readiness cache and re-check now." }
      },
      (args, exec) => operations.setup(exec, args)
    )
  ];
}
