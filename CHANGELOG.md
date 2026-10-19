# Changelog

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
