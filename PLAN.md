# Deep Plan — Codex for DeepSeek Harness

Status: **implemented, installed, and verified end-to-end** (live Codex runs from the
Harness Host, not mocks). This document is the plan the implementation followed,
updated with the verification evidence and the remaining limits.

Deliverable: [`dsh-codex/`](dsh-codex) — a Host-only DSH bundle `@local/dsh-codex`
(installed into the `desktop` profile), with tools, slash commands, prompt guidance,
two embedded skills, and a vendored/adapted Codex companion runtime.

---

## 1. Mission

Make OpenAI Codex a first-class worker inside DeepSeek Harness, porting the workflow of
OpenAI's [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) to the
Harness plugin model:

- **Review** local changes or a branch with Codex's native reviewer (read-only).
- **Adversarially review** the approach/design with steerable focus text (read-only).
- **Rescue/delegate** an investigation or implementation to a persistent Codex thread.
- **Manage** durable Codex job records (status/result) and cancel running work.
- **Background execution** integrated with native DSH jobs (streaming, kill, wake notice).
- **Setup/readiness** checks for the Codex CLI/app-server/auth.
- Give the model Codex-specific prompting/result-handling guidance as DSH skills.

Explicitly out of scope for v1 (see §10): the Claude-specific Stop review gate,
Claude-session transfer, a Codex-specific Web UI panel, and any change to Codex itself.

## 2. Constraints discovered during recon

Recon reports (kept in [`docs/`](docs)):

- [`docs/source-runtime.md`](docs/source-runtime.md) — full port spec of the Claude plugin
  runtime (CLI surface, broker, state layout, Claude coupling table, port map; 91/91
  upstream tests pass).
- [`docs/dsh-host-api.md`](docs/dsh-host-api.md) — exact DSH bundle/tool/command/jobs/
  prompt/skills contracts, verified against the installed DSH 0.2.1-rc.2; the zero-import
  raw-`ToolDefinition` path is the lowest-risk bundle shape.
- [`docs/codex-protocol.md`](docs/codex-protocol.md) + [`probes/`](probes) — Codex 0.163
  app-server protocol probe: compatible with small patches; three real drifts found and
  fixed/avoided.

Hard facts that shaped the design:

1. The DSH Host is Electron; plugins run in-process and their child processes are **not**
   inside the DSH file sandbox. Codex must therefore be spawned directly (never through
   the `bash` tool), and it applies its own sandbox/approval policy.
2. `codex app-server` (0.163) needs a writable `CODEX_HOME` (SQLite state). Works from the
   Host with the user's real `~/.codex`; fails only when nested inside a sandbox.
3. The Claude plugin's runtime is wire-compatible with 0.163; the port risk is the
   Claude-specific plumbing (env injection, hooks, commands Markdown, transfer), not
   JSON-RPC.
4. The runtime's `state.json` is read-modify-write with no locking; DSH runs tools
   concurrently, so a cross-process lock was added.
5. A zero-import, zero-peer bundle is installable and live-activatable without restart;
   bare `@deepseek-ai/*` imports would pin the plugin to an exact DSH version.

## 3. Architecture

```
index.js                         Host plugin entry (zero bare imports)
  ├─ 6 tools                     codex_review, codex_adversarial_review, codex_rescue,
  │                              codex_status, codex_result, codex_setup
  ├─ 7 slash commands            /codex-review, /codex-adversarial-review, /codex-rescue,
  │                              /codex-status, /codex-result, /codex-cancel, /codex-setup
  ├─ system-prompt section       when/how to delegate, review-safety rules
  └─ 2 runtime skills            codex-delegation, codex-result-handling
lib/runtime.js                   executable resolution (node/codex), child env, argv,
                                 prompt files, stored-job lookup
lib/jobs.js                      ctx.jobs integration: one Codex run = one DSH job,
                                 streaming, kill/interrupt, foreground collection
lib/operations.js                high-level review/rescue/status/result/cancel/setup
runtime/                         vendored codex-companion (Apache-2.0, patched)
workspace `state/<slug>-<hash>/`  durable job records, broker endpoint, logs
```

Run flow (background): tool → `ctx.jobs.start({kind:'codex'})` → producer spawns
`node runtime/scripts/codex-companion.mjs … --job-id <harnessJobId>` → companion connects to
the per-workspace app-server broker → streams stdout/stderr into the job's output ring →
settles; `job_output` streams/collects, `job_kill` aborts the child **and** interrupts the
Codex turn via the companion's cancel path. The Harness job id is passed as the companion's
job id, so DSH, companion state, and `codex_result` share one identity.

Foreground: same job machinery, owned by the calling session, awaited and collected, then
the record is removed; falls back to a direct child if the jobs service/controller is
absent.

## 4. Parity with the Claude Code plugin

| Claude plugin feature | DSH implementation | Status |
| --- | --- | --- |
| `/codex:review` (wait/background) | `codex_review` tool + `/codex-review` | ✅ live (native `review/start` inline) |
| `/codex:adversarial-review` | `codex_adversarial_review` + focus-file | ✅ live (`turn/start` + JSON output schema) |
| `/codex:rescue` via subagent | `codex_rescue` tool (no forwarding layer needed) | ✅ live |
| `--background` detached worker | native `ctx.jobs` (streams, cancel, wake notice) | ✅ live |
| `--resume` / `--fresh` | `resume_last` / `fresh` (`thread/resume`) | ✅ live |
| `/codex:status`, `/codex:result` | tools + commands, durable records | ✅ live (workspace-scoped + cross-workspace id fallback) |
| `/codex:cancel` | `/codex-cancel`, `job_kill` | ✅ live (interrupts the Codex turn) |
| `/codex:setup` | `codex_setup` / `/codex-setup` | ✅ live |
| model/effort overrides, `spark` alias | `model`/`effort` params | ✅ wired (passed through; runtime maps `spark`) |
| bundled skills (`codex-cli-runtime`, `gpt-5-4-prompting`, result handling) | `codex-delegation`, `codex-result-handling` runtime skills | ✅ registered in catalog |
| `Stop` review gate | — | ⛔ dropped in v1 (no equivalent decision at `agent/turn-stopping`) |
| session transfer | — | ⛔ dropped in v1 (Codex imports Claude JSONL only) |
| per-command execution-mode guesswork | tool/command descriptions + `background` parameter | ✅ simplified |

## 5. Runtime port map (patches to the vendored runtime)

| File | Change |
| --- | --- |
| `lib/state.mjs` | `CODEX_COMPANION_DATA_DIR` (Claude env as fallback), directory lock + atomic writes for `state.json`/job files, tolerant job-file reads |
| `lib/app-server.mjs` | manifest path `runtime/plugin.json`; clientInfo `DeepSeek Harness` |
| `codex-companion.mjs` | removed Claude transfer/hook support; `--job-id` override; `--focus-file`; `jobId` in foreground JSON; DSH hint strings; setup/status no review-gate text |
| `lib/codex.mjs` | `thread/list` no longer filters `sourceKinds:["appServer"]` (0.163 records `vscode`); tolerate ephemeral `thread/name/set`; client name and hints |
| `lib/render.mjs`, `lib/job-control.mjs` | DSH commands (`job_output`, `job_kill`, `codex_*`) in hints; removed review-gate/needs-review rendering |
| dropped | `hooks/*`, `session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs`, `claude-session-transfer.mjs`, `commands/*.md`, `agents/*.md`, `.claude-plugin/` |
| verbatim | `git.mjs`, `fs.mjs`, `args.mjs`, `prompts.mjs`, `workspace.mjs`, `process.mjs`, `broker-endpoint.mjs`, adversarial prompt, review schema, broker, LICENSE/NOTICE |

Added around it: the whole DSH layer (`index.js`, `lib/`), 30 hermetic tests, README,
NOTICE, original icon/display metadata (en/zh).

## 6. Milestones (all complete)

1. **Recon** (3 parallel analysts): source runtime port spec; DSH host API contract;
   Codex 0.163 protocol probe.\
2. **Runtime validation before porting**: ran the unmodified companion against Codex
   0.163 (setup/auth, trivial `task`, `review` on a scratch repo, detached background
   worker + status/result) to de-risk the vendoring decision.\
3. **Vendor + patch** the runtime; validate patched runtime (`--job-id`, new data dir,
   session env) against 0.163.\
4. **DSH layer**: tools, commands, prompt section, skills, config/env resolution,
   node/codex discovery for Electron hosts.\
5. **Concurrency hardening**: state lock, atomic writes, cancelled-run dedupe.\
6. **Tests**: 30 unit tests (fake ctx/jobs/runner, no Codex calls).\
7. **Install**: `plugin_manager install_bundle` → `applied`, live in the profile.\
8. **Live verification** (see §7) and one bundle toggle to prove module replacement
   reloads the adapter without a desktop restart.

## 7. Verification evidence (live, this machine)

- `codex_setup` through the Host: ready; Codex 0.163.0; ChatGPT auth for the user.
- `codex_review` **background** on a scratch repo: job `codex-4db80061b57d42fe`, streamed
  progress + final review, correctly flagged the seeded P1 (`math.js:2`), completed status.
- `codex_result` with that job id from a different working directory: durable record
  rendered (review + status + Codex session id), proving cross-workspace id resolution.
- `codex_rescue` **foreground**: returned `FOREGROUND_OK` (job machinery, output
  collection, record cleanup).
- `codex_adversarial_review`: parsed JSON verdict `needs-attention`, high-severity finding,
  recommendation — `turn/start` + output schema path works on 0.163.
- `codex_rescue` **background + `job_kill`**: started, killed mid-turn; `job_output`
  showed `[status: killed, …]`; companion state shows `cancelled` with a resumable Codex
  thread id.
- `codex_rescue resume_last`: returned `RESUMED_OK` (thread/resume works).
- Tools visible in the live tool list; both skills appeared in the session skill catalog;
  plugin activation reported `application: applied` with no warnings.
- Unit tests: 67/67 pass (`npm test`; 37 added across the hardening rounds).
- Not verified: clicking the `/codex-*` slash commands in the GUI composer (registered in
  the Host commands registry and unit-tested; no browser control in this session).

## 7b. Hardening round (deep review with Codex)

After v1 shipped, the plugin was reviewed by Codex itself (native `codex_review` plus a
delegated read-only `codex_rescue` audit) and by an independent reviewer agent. The
union was 0 P0, 8 P1, 19 P2 confirmed issues; all P1s and the material P2s were fixed
and covered by regression tests. The review also produced concrete communication and
latency improvements:

- continuity footer (Codex thread id + `codex resume`) on foreground results;
- workspace-scoped status/result/resume (new sessions see and can continue prior work);
- durable-result fast path and 30 s setup-readiness cache (status/result by id no longer
  spawn a process; repeated setup is instant);
- safer, stricter command parsing (`--` separator, flags only before text, unknown
  options rejected);
- broker lifecycle: cross-process creation lock, atomic `broker.json`, idle reaping and
  app-server-death propagation; transport-death no longer hangs turn capture;
- retention never evicts live jobs; cancellation reports true outcomes and refuses to
  guess between live jobs; prompt-file cleanup on failed background starts;
- pinned resolved Codex executable, real documented env overrides, profile-independent
  data directory, `~` expansion, bounded process capture, Windows tree kill.

A second Codex review of the patched plugin found 2 further P1s (untracked-symlink
disclosure in review context; an idle-reaper bug introduced by the broker fix) and 5 P2s;
all were fixed and regression-tested. A third round closed the residual risks after a
Codex design consultation: typed handling for all ten app-server server-to-client request
methods, Harness-approval gating for write-capable runs (`writeApproval` config), an
active-turn-safe broker reaper with unit-tested Windows/POSIX tree kill, and the remaining
low-impact findings. Final live checks: promptless `resume_last`, workspace-scoped status,
cached setup, a foreground rescue with continuity metadata, and a refused write run.

Full report: [`docs/REVIEW.md`](docs/REVIEW.md); independent reviewer:
[`docs/internal-review.md`](docs/internal-review.md).

## 8. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Concurrent state writes corrupt records | cross-process directory lock + atomic rename; killed-run detail dedupe |
| Codex CLI not on the Host `PATH` (Finder launch) | multi-candidate discovery (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, PATH) + `codexPath` config/env |
| Host Node/Electron mismatch | resolve a real node first; fall back to `ELECTRON_RUN_AS_NODE=1` with the app binary; `nodePath` config/env |
| Codex protocol drift (future CLI) | only stable v2 methods used; explicit drift fixes for 0.163; setup reports version; probes kept in `probes/` |
| Codex asks the client for approval/input (server→client requests) | runtime answers unsupported requests with `-32601`; tasks run with approval policy `never` and explicit sandbox. A future Codex that requires elicitation would need handlers |
| Stale broker after external kill | per-workspace `broker.json`; documented cleanup; broker reaped by lifecycle checks |
| `~/.codex` not writable / nested sandbox | documented; Host path is unsandboxed, and `CODEX_HOME` can be redirected |
| State/memory growth | runtime prunes to the last 50 job records; output ring bounded by DSH jobs (256 KiB) |
| Review output auto-applied | tool descriptions + prompt section + skill explicitly forbid auto-fixing; review tools are read-only |

## 9. Files

- [`dsh-codex/index.js`](dsh-codex/index.js) — registration
- [`dsh-codex/lib/runtime.js`](dsh-codex/lib/runtime.js), [`lib/jobs.js`](dsh-codex/lib/jobs.js), [`lib/operations.js`](dsh-codex/lib/operations.js)
- [`dsh-codex/runtime/`](dsh-codex/runtime) — vendored companion (patched)
- [`dsh-codex/skills/`](dsh-codex/skills) — embedded skills
- [`dsh-codex/README.md`](dsh-codex/README.md) — install/config/troubleshooting
- [`dsh-codex/test/`](dsh-codex/test) — 30 tests
- [`docs/`](docs), [`probes/`](probes) — recon evidence

## 10. Roadmap

1. Replace the custom broker with Codex's native `app-server --listen unix://`
   (WebSocket-over-unix) if its multi-client semantics prove stable.
2. A Stop-time review gate via `agent/turn-stopping` + follow-up injection (needs a safe
   blocking contract).
3. DSH session transfer: export the Harness session into a Codex thread (Codex's
   `externalAgentConfig/import` only understands Claude today).
4. Optional Web UI panel for Codex jobs/threads using DSH slots and theme tokens.
5. Config schema with peer dependencies once the bundle is versioned against a stable DSH
   release; per-run `serviceTier`/sandbox options.
6. Cross-workspace `codex_status` listing and a model-facing `codex_cancel` tool alias for
   `job_kill`.
