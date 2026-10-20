---
name: codex-delegation
description: How to hand work to the OpenAI Codex CLI from DeepSeek Harness and write task briefs Codex executes well.
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

## Writing the task brief

Codex starts with the repository but none of this conversation. The quality of its
answer is capped by the brief, so spend a few sentences on it. The plugin wraps every
`codex_rescue` task in a fixed envelope (access rules, working rules, and the report
format), so the brief only carries the substance:

```text
Goal: <the outcome you need, in one sentence>
Context: <what Codex cannot find quickly: relevant files, the exact error or failing
         output, how to reproduce, what you already tried or ruled out>
Constraints: <what must not change, conventions, scope limits>
Done when: <the observable result: a test that passes, a question answered, a diff>
```

Good brief:

```text
Goal: find why GET /orders?page=2 returns page 1 again.
Context: src/api/orders.ts builds the query; src/db/paginate.ts computes offsets.
`npm test -- orders` fails: "expected id 11, got 1". Started after commit a1b2c3d.
I ruled out caching: the bug reproduces with CACHE_DISABLED=1.
Constraints: keep the public paginate() signature.
Done when: root cause with file:line, and a fix as a diff.
```

Weak brief: "pagination is broken, please look". Codex then spends its run rediscovering
what you already know, and may investigate the wrong layer.

Rules:

- One task per run. Split unrelated questions into separate runs, or background jobs.
- Paste exact error text and command output; do not paraphrase them.
- Do not ask for a report format, a plan, or progress updates: the envelope defines the
  report, and asking for upfront plans makes Codex stop early.
- Prefer a sharper brief over a higher `effort`. Raise `effort` only for genuinely hard
  problems.
- For `codex_adversarial_review`, put the decision or risk to challenge in `focus`, plus
  context the repository does not show (requirements, expected load, constraints).

## Communication contract

- Put option flags before the task text; after the first text token, tokens are literal
  text. Use `--` when the text itself starts with dashes.
- Pass `cwd` explicitly when the target differs from the session directory; relative
  paths resolve against the session directory.
- One self-contained task per Codex run. Do not ask Codex to re-derive facts you can
  check locally faster.
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
uncertainty markers. If Codex made edits, say so and list the files it edited. If the
run failed or Codex is not authenticated, report the failure and point at
`codex_setup`; never fabricate a substitute answer. The `codex-result-handling` skill
explains how to read and act on each result format.

_Adapted from the OpenAI Codex plugin for Claude Code (Apache-2.0)._
