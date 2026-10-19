---
name: codex-delegation
description: How to hand work to the OpenAI Codex CLI from DeepSeek Harness and compose prompts Codex executes well.
---

# Delegating to Codex

Codex is a second, independent coding agent running locally through the Codex CLI.
Delegate to it when a second pass adds real value: deep root-cause work, a substantial
implementation the user wants delegated, a review before shipping, or a design
challenge. Do not delegate small work the main agent can finish quickly.

## Choosing the tool

| Need | Tool |
| --- | --- |
| Review of local changes or a branch | `codex_review` (`base` for a branch) |
| Challenge the design, tradeoffs, assumptions, risk areas | `codex_adversarial_review` (`focus`) |
| Investigate, diagnose, implement, continue prior Codex work | `codex_rescue` (`task`, `write`, `resume_last`) |
| Read durable Codex job records | `codex_status`, `codex_result` |
| Check installation/authentication | `codex_setup` |

Background: pass `background: true` for anything larger than a tiny diff. You then get a
Harness background job id; read it with `job_output`, cancel with `job_kill`, and you are
notified on completion. Do not busy-poll, sleep, or duplicate the running work.

## Prompt composition

Prompt Codex like an operator, not a collaborator: one clear task per run, a stated
definition of done, and only the constraints that matter. Prefer better prompt contracts
over raising reasoning effort. Use stable XML-ish tags when the answer must be structured.

Default blocks:

- `<task>`: the concrete job plus relevant repository/failure context. State the working
  directory if it differs from the session directory.
- `<output_contract>`: exact shape, ordering, and brevity. Ask for findings ordered by
  severity with file:line references for reviews; for implementation, ask for touched
  files and a verification summary.
- `<follow_through_policy>`: what Codex should do instead of asking routine questions
  (for example: keep going, make the smallest safe patch, and report assumptions).
- `<verification_loop>`: required for fixes and risky changes. Ask Codex to run the
  relevant tests or checks and to say what it ran.
- `<grounding_rules>`: required for reviews and research. Claims must point at observed
  evidence; label hypotheses as hypotheses; never invent file paths.

When to add blocks:

- Coding/debugging: `completeness_contract`, `verification_loop`, `missing_context_gating`.
- Review/adversarial review: `grounding_rules`, `structured_output_contract`, `dig_deeper_nudge`.
- Research/recommendation: `research_mode`, `citation_rules`.
- Write-capable tasks: `action_safety` (stay narrow, no unrelated refactors).

Only tighten the prompt when the request is genuinely ambiguous. Do not rewrite the user's
intent, and do not paste the whole repository into the prompt.

## Communication contract

- Put option flags before the task text; after the first text token, tokens are literal
  text. Use `--` when the text itself starts with dashes.
- Pass `cwd` explicitly when the target differs from the session directory; relative
  paths resolve against the session directory.
- One self-contained task per Codex run, with the expected output shape. Do not ask
  Codex to re-derive facts you can check locally faster.
- Foreground results end with `Codex session:` and a `codex resume <id>` line. Continue
  that thread with `resume_last: true`; do not start a fresh thread for a follow-up.
- Prefer `background: true` for anything larger than a tiny diff, then collect with
  `job_output` / `codex_result <id>`; do not poll. The background result includes the
  Codex thread id for continuation.

## Write-capable rescue runs

`codex_rescue` is read-only unless `write: true`. Set it only when the user wants changes
made: write runs use Codex's own workspace-write sandbox and are gated by Harness approval
(the session approval policy applies), so a model-initiated write run does not start if
approval is refused. A human typing `--write` in a slash command is explicit consent. If
approval is refused, report it and offer a read-only pass instead of retrying. For diagnosis or research, leave it unset. For follow-ups on the same Codex thread,
use `resume_last: true` and send only the delta instruction instead of restating the task.

## Result rules

Report Codex output faithfully. Preserve verdict, severity order, file paths, and any
uncertainty markers. If Codex made edits, say so and list the touched files it reported.
If the run failed or Codex is not authenticated, report the failure and point at
`codex_setup`; never fabricate a substitute answer.

_Adapted from the OpenAI Codex plugin for Claude Code (Apache-2.0)._
