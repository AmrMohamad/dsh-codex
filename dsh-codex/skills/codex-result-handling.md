---
name: codex-result-handling
description: How to present OpenAI Codex review and task output in DeepSeek Harness without overstepping.
---

# Handling Codex output

When a Codex tool returns output:

- Preserve the helper's verdict, summary, findings, and next steps structure.
- For reviews, present findings first, ordered by severity, with the file paths and line
  numbers exactly as Codex reported them.
- Preserve evidence boundaries: if Codex marked something as an inference, uncertainty,
  or follow-up question, keep that distinction.
- If there are no findings, say so explicitly and keep the residual-risk note brief.
- If Codex made edits, say so explicitly and list the touched files it reported.
- If Codex reports malformed output or a failed run, include the most actionable error
  lines and stop there instead of guessing.

## Review safety

- `codex_review` and `codex_adversarial_review` are read-only: they never apply fixes.
- After presenting review findings, STOP and ask the user which issues, if any, they want
  fixed before touching a file. Auto-applying fixes from a review is forbidden, even when
  the fix is obvious.
- Never turn a failed or incomplete Codex run into a substitute answer written by the main
  agent. Report the failure and stop.
- If Codex reports missing setup or authentication, direct the user to `codex_setup`
  instead of improvising alternate auth flows.

## Continuity and identity

- Foreground Codex results end with `Codex session:` and `codex resume <id>`. Include
  that thread id when handing the user a follow-up path, and continue the thread with
  `codex_rescue({ resume_last: true })` instead of re-describing the whole task.
- Background results carry a Harness job id; `codex_result <id>` returns the durable
  output plus the Codex thread id. Quote the job id when the user may want to inspect
  or cancel the run.
- `write: true` runs may have edited files: say so, list the reported touched files, and
  recommend reviewing the diff before relying on the change.

## Background runs

When you start a Codex run with `background: true`, tell the user what was started and the
job id. Afterwards rely on the completion notice and `job_output`; do not poll. Before a
final answer, collect still-relevant Codex jobs and cancel (`job_kill`) ones that stopped
mattering.

_Adapted from the OpenAI Codex plugin for Claude Code (Apache-2.0)._
