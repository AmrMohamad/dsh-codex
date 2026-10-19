# Prompts — how DeepSeek Harness talks to Codex, and what comes back

This is the design of every message that crosses between the DeepSeek Harness (DSH) agent
and Codex, and of the results that come back. Goal: Codex returns well-structured, direct,
detailed results that the DSH agent can act on without re-investigating.

## 1. Every channel

| Direction | Channel | Owner | File |
| --- | --- | --- | --- |
| DSH → Codex | `codex_rescue` task, wrapped in the **task envelope** | brief: DSH agent; envelope: plugin | `runtime/prompts/task.md`, `task-read-only.md`, `task-write.md` |
| DSH → Codex | `codex_adversarial_review` prompt + JSON output schema | plugin (+ DSH `focus` text) | `runtime/prompts/adversarial-review.md`, `runtime/schemas/review-output.schema.json` |
| DSH → Codex | `codex_review`: Codex's **native** reviewer (`review/start`) | Codex itself | — (we only choose the target) |
| Codex → DSH | task report, review findings, native review | rendered by the runtime | `runtime/scripts/lib/render.mjs` |
| Plugin → DSH | how to brief Codex and how to act on results | plugin | `lib/tools.js` (descriptions), `lib/prompt.js`, `skills/*.md` |

Builders live in `runtime/scripts/lib/prompts.mjs` (`buildTaskPrompt`,
`buildAdversarialReviewPrompt`) so tests can inspect exactly what Codex receives.

## 2. Principles and where they come from

1. **Put the output contract on the Codex side, not in the caller's hands.** Previously the
   DSH agent had to hand-write XML "output contract" blocks from a skill; when it did not,
   Codex answered in its terminal style ("very concise", 4–6 bullets) for a human, not for
   an agent. The envelope now adds the contract to every task, so the result shape no longer
   depends on how well the caller prompts. ([Anthropic, multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system):
   each delegated task needs "an objective, an output format, guidance on the tools and
   sources to use, and clear task boundaries".)
2. **The caller supplies substance: goal, context, constraints, done-when.** That is what the
   DSH agent knows and Codex does not. Tool descriptions (always visible to the model) and the
   `codex-delegation` skill teach this brief. Vague briefs make subagents misread the task or
   duplicate work (same Anthropic source).
3. **Follow Codex's own prompting guidance.** From OpenAI's
   [Codex Prompting Guide](https://github.com/openai/openai-cookbook/blob/main/examples/gpt-5/codex_prompting_guide.ipynb):
   - do not ask for upfront plans, preambles or status updates ("can cause the model to stop
     abruptly before the rollout is complete");
   - bias to action; every rollout ends "with a concrete edit or an explicit blocker plus a
     targeted question" → our `Status: done | partial | blocked` line;
   - reviews: "Present findings first (ordered by severity with file/line references) …
     If no findings are discovered, state that explicitly and mention any residual risks";
   - file references as standalone `path:line`.
4. **Write for an agent reader.** Codex's default final message is tuned for a person at a
   terminal. The envelope says the reader is another coding agent, asks for precise detail
   over brevity (without filler), and fixes the section order so the DSH agent can find the
   status, evidence, changes, verification gaps and next steps at the same place every time.
5. **Separate facts from inferences.** Claims cite `path:line`; anything not confirmed by
   reading or running is labelled "Inference:". Adversarial findings carry a calibrated
   confidence. Edited files are reported from Codex's file-change events ("observed"), next
   to what the report claims.
6. **Make every result actionable.** Read-only runs return exact diffs the DSH agent can
   apply. Adversarial findings carry a failure scenario, a fix and a verification test, and
   have ids (`F1`…) so the user can pick ("fix F2").
7. **Keep the native reviewer native.** Codex 0.163's built-in review prompt (extracted from
   the published binary for this work) already defines P0–P3 priorities, a confidence score,
   short line ranges and a correctness verdict. We do not replace it; we only add a one-line
   priority legend when rendering.

## 3. The task envelope (`codex_rescue`)

```text
<task>            the DSH agent's brief, verbatim (thread name also uses it)
<access>          read-only: investigate, return exact diffs | write: smallest complete change,
                  no commits/pushes, run relevant checks
<working_rules>   finish in this turn; stop only when truly blocked; root cause; cite path:line;
                  label inferences; stop looping
<report_contract> the report sections below, fixed order, "None." for empty sections
```

Report sections (in order):

| Section | Content | How the DSH agent uses it |
| --- | --- | --- |
| `## Outcome` | `Status: done \| partial \| blocked — <direct answer>` + ≤3 sentences | Lead with it; `partial`/`blocked` → resolve the question, continue with `resume_last` |
| `## Details` | evidence bullets with `path:line`, inferences labelled | Keep references and labels when reporting |
| `## Changes` | write: edited files and why; read-only: exact diffs | Check, then apply what the request calls for |
| `## Verification` | commands run + results; what was not verified | Run unverified checks before relying on them |
| `## Risks and open questions` | assumptions, remaining risks, user decisions | Surface the decisions to the user |
| `## Next steps` | numbered actions for the calling agent | The DSH agent's to-do list |

The job summary shown by `codex_status` is the `Status:` line.

## 4. Adversarial review contract

- Prompt defines a **severity scale** (critical / high / medium / low, with blocking
  meaning) and a **confidence scale** (0.9+ traced, 0.6–0.8 one inferred step, 0.3–0.5
  assumption-based, below 0.3 not reported). It says "do not stop at the first finding"
  (from Codex's native reviewer) and limits pre-existing issues to ones the change makes
  worse or reachable.
- Schema (strict-mode compatible: every object lists all keys as required, no extra keys).
  Keys are ordered **reasoning first**: each finding's `failure_scenario`, `body`,
  `recommendation`, `verification` come before `confidence`, and `findings` /
  `residual_risks` come before `verdict` / `summary`, so the scores are produced after the
  evidence.
- Rendering: `Verdict: … (N findings: counts)`, then `### F1 · high · confidence 0.90 — title`
  with `Location`, `Scenario`, `Why`, `Fix`, `Verify`; then `Residual risks` and numbered
  `Next steps`. Records stored before these fields existed still render.

## 5. Changing a prompt safely

1. Edit the `.md` template or schema; keep instructions short and concrete.
2. `npm test` runs `test/prompts.test.mjs` (contract and docs stay in sync) and
   `test/e2e-companion.test.mjs` (the real companion and broker against
   `test/fixtures/fake-codex.mjs`: asserts what reaches Codex and what comes back).
3. If you add a schema field, explain it in the prompt (a test checks every field is
   mentioned) and render it in `render.mjs`.
4. Live-check with a real Codex before release; the fake proves wiring, not model behavior.
5. Record vendored-runtime changes in `NOTICE` and `dsh-codex/NOTICE`.
