# Changelog

## Unreleased

Research-driven hardening: the upstream issue trackers of similar bridges were swept
and every applicable failure mode was checked against this repo
([docs/RESEARCH.md](docs/RESEARCH.md)).

### Fixed (vendored runtime, each with a regression test)

- Turn capture hung forever when the start response had no `turn.id` (upstream #781).
- Task thread names could end in half an emoji; the app-server then never answered
  `thread/name/set` and the task hung (#793).
- A usage-limit `error` followed by an ordinary `turn/completed` was reported as a
  successful run with no output (openai/codex#47728). It is now a failure with the
  Codex error shown.
- A broker that missed its 2 s readiness window was abandoned alive with its
  `codex app-server`; repeated cold starts stacked them on one `~/.codex` (#801, #789).
- Review context dropped the leading `git status` column (#813) and skipped
  non-ASCII untracked files such as `café.js` (#812).
- Untracked files were inlined into review prompts without a total cap; now 64 KiB.
- Inline `--key=value` options were cut at the second `=` (#807).

### Fixed (plugin layer)

- Failed background jobs said only "exited with code 1": the job status now carries a
  bounded stderr tail.
- `codex_setup` cached "needs attention" reports, hiding a fresh `codex login` for 30 s.
- Node resolution is cached even while Codex is missing, so the Host no longer re-runs
  blocking probes on every call.

### Added

- `Hint:` lines for usage limits, expired/reused auth tokens and a missing CLI, so the
  agent takes the next step instead of retrying (`lib/diagnose.js`).
- `AGENTS.md` (module map, invariants, test rules) and `docs/RESEARCH.md`.

### Changed

- `index.js` and `lib/runtime.js` split into single-purpose modules (`tools`, `commands`,
  `prompt`, `skills`, `resolve`, `process`, `argv`, `job-store`, `diagnose`, `text`);
  duplicated flows in `operations.js` are now shared helpers. No tool, command or
  config changes.
- `/codex-status` usage now lists options before the job id (options after text are
  literal).

## 0.1.0 — 2026-10-19

Initial public release.

### Features

- Native DeepSeek Harness tools: `codex_review`, `codex_adversarial_review`,
  `codex_rescue`, `codex_status`, `codex_result`, `codex_setup`.
- Slash commands: `/codex-review`, `/codex-adversarial-review`, `/codex-rescue`,
  `/codex-status`, `/codex-result`, `/codex-cancel`, `/codex-setup`.
- Embedded skills: `codex-delegation`, `codex-result-handling`.
- One Codex run per native DSH background job: streaming, `job_output`, `job_kill`,
  completion wake-ups, durable records with Codex thread ids.
- Thread continuity: foreground results include the Codex session id and resume command;
  `resume_last` continues the previous thread, including from a new DSH session.
- Harness-approval gate for write-capable runs (`writeApproval: ask|allow|deny`).
- Typed, schema-valid refusals for all Codex app-server server-to-client requests.
- Workspace-scoped status/result/resume with cross-workspace durable fallbacks.
- Readiness caching, direct-state fast paths, and hermetic test suite (67 tests).

### Hardening (5 review rounds, see docs/REVIEW.md)

- Fixed 10 P1 and 26 P2 findings, including: command-parser crashes, promptless-resume
  failure, broker creation races and process leaks, transport hangs, cancellation
  races/timeouts, retention evicting live jobs, symlink credential disclosure, stale
  config crash, and false "not logged in" on a busy broker.
- Vendored runtime patches documented in `dsh-codex/NOTICE` and `NOTICE`.
