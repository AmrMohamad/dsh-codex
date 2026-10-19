---
name: codex-result-handling
description: How to read, report, and act on OpenAI Codex task reports and review findings in DeepSeek Harness without overstepping.
---

# Handling Codex output

Each Codex tool returns a fixed format. Read it by section, keep its structure when you
report to the user, and act on it as below.

## Task reports (`codex_rescue`)

Codex answers with these sections, in order:

| Section | What to do with it |
| --- | --- |
| `## Outcome` (`Status: done / partial / blocked — …`) | Lead with this line when reporting. `partial` or `blocked`: settle the open question (ask the user when only they can decide) and continue with `resume_last` plus the answer. Do not re-run the whole task. |
| `## Details` | The evidence. Keep the `path:line` references and the "Inference:" labels. Do not restate inferences as facts. |
| `## Changes` | Write run: the edits Codex made; compare with "Files Codex edited (observed)", which comes from the actual file-change events. Read-only run: exact diffs. Check each against the code, then apply the ones the user's request calls for. |
| `## Verification` | Trust only what Codex ran. Anything listed as unverified, run it yourself before relying on it, or tell the user it is unverified. |
| `## Risks and open questions` | Surface decisions that need the user. Carry the rest into your own work. |
| `## Next steps` | Your action list. Do the ones in scope; offer the rest. |

If a report lacks these sections (for example an older Codex), use it as it is and say
what is missing rather than guessing.

## Review output

- `codex_adversarial_review` returns `Verdict: approve | needs-attention (counts)` and
  findings `F1..Fn`, ordered by severity, then confidence. Each finding has severity,
  confidence (0 to 1), location, scenario, why, fix, and verify. Refer to findings by id
  ("F2") so the user can choose. Confidence 0.6 to 0.8 means one step is inferred; below
  0.6 the finding rests on assumptions it states. Say so when you relay it. Also report
  `Residual risks`: they are what the review did not cover.
- `codex_review` (native reviewer) tags findings `[P0]` (blocks release) to `[P3]` (nice to
  have), each with a file and line range. Present them in that order.
- Preserve the verdict, summary, findings, and next steps structure. Keep file paths and
  line numbers exactly as Codex reported them.
- If there are no findings, say so explicitly and keep the residual-risk note brief.
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
- `write: true` runs may have edited files: say so, list the files Codex edited, and
  recommend reviewing the diff before relying on the change.

## Background runs

When you start a Codex run with `background: true`, tell the user what was started and the
job id. Afterwards rely on the completion notice and `job_output`; do not poll. Before a
final answer, collect still-relevant Codex jobs and cancel (`job_kill`) ones that stopped
mattering.

_Adapted from the OpenAI Codex plugin for Claude Code (Apache-2.0)._
