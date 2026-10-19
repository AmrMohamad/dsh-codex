# codex-plugin-cc runtime analysis → DeepSeek Harness port spec

**Status:** source analysis complete; this document is the source of truth for porting the runtime.
**Author:** source-analyst (shared task `task-1`).
**Date:** 2026-10-19.

## Provenance and method

- **Source of truth:** `~/Developer/codex-deepseek-plugin/codex-plugin-cc` — `@openai/codex-plugin-cc` **v1.0.6**, `plugins/codex/` (git HEAD `db52e28` "Remove shell expansion for git commands (#447)"). The copy installed at `~/.claude/plugins/marketplaces/openai-codex` is **v1.0.2** and staler (no `transfer`, older commands); it was not used.
- **Target host:** installed Codex CLI `codex-cli 0.163.0` (much newer than the plugin's written-against version). The current 0.163.0 app-server JSON-RPC schema was generated locally to a scratch dir with `codex app-server generate-json-schema --out <tmp>` and compared against every RPC the plugin makes (see §9.1). All plugin RPCs and params still exist.
- **Read in full:** `scripts/codex-companion.mjs` (1073 l), `scripts/app-server-broker.mjs` (252 l), every `scripts/lib/*.mjs` (including `codex.mjs` 1219 l, `git.mjs` 347 l, `render.mjs` 465 l, `job-control.mjs` 308 l, `tracked-jobs.mjs` 204 l, `state.mjs` 191 l, `broker-lifecycle.mjs` 209 l, `app-server.mjs` 354 l, `app-server-protocol.d.ts` 75 l, `claude-session-transfer.mjs` 44 l), all 8 `commands/*.md`, `agents/codex-rescue.md`, `hooks/hooks.json`, both hook scripts, `prompts/*.md`, all 3 `skills/*/SKILL.md` (+ reference files skimmed), `schemas/review-output.schema.json`, and all 9 test files incl. `tests/runtime.test.mjs` (2259 l) and `tests/fake-codex-fixture.mjs` (658 l).
- **Tests run** (details §8): `cd codex-plugin-cc && npm test` → **91/91 pass, 0 fail, 81.86 s** on Node `v26.12.0`, npm `11.20.0`; no `node_modules` required (tests use only `node:test` + builtins).
- **Live CLI samples:** all outputs quoted in §1.6 were produced by actually running the companion against the repo's `fake-codex-fixture` in a scratch `/tmp` git repo on 2026-10-19 (never against the real Codex, because this analysis sandbox forbids writes to `~/.codex`; see §9.2).
- **DSH side** was grounded with the Host Service/Event inspect providers (`cordis_inspect_query`, 2026-10-19); signatures quoted in §6 are from that live catalog, not guesswork.

**TL;DR for the Lead:** the runtime is four layers — (a) a single-file CLI (`codex-companion.mjs`) that is the entire command surface, (b) a vendored JSON-RPC client for `codex app-server` with a hand-rolled per-workspace Unix-socket multiplexing broker, (c) a file-backed job/state store under a per-repo hash directory, (d) markdown prompt/schema assets. Port it by vendoring `plugins/codex/scripts/**` + `prompts/` + `schemas/` (layout preserved), replacing 6 Claude env vars with an injected context object, and rewriting the Claude-specific markdown command/hook layer. Codex 0.163.0 is wire-compatible with every call the runtime makes (verified against generated schema); the top risks are concurrent-state races, `CODEX_HOME` writability, session-id plumbing, and scope decisions on hooks/transfer (`transfer` should be dropped: it hard-codes `~/.claude/projects` and Claude JSONL). A DSH-native rewrite would use `ctx.tools.register` / `ctx.commands.register` / `ctx.jobs` / `ctx.userQuestions` instead of the CLI and hook scripts (§6).

---

## 1. Companion CLI contract (`plugins/codex/scripts/codex-companion.mjs`)

### 1.1 Invocation model and argument normalization

Entry point: `node scripts/codex-companion.mjs <subcommand> [args...]`. `main()` reads `process.argv.slice(2)`; no subcommand, `help` or `--help` prints usage and exits 0 (`codex-companion.mjs:75-89, 1024-1029`).

Two normalization quirks matter for the tool layer:

1. **Raw-string argument splitting** — if the process receives **exactly one** argv element, it is re-split shell-style by `splitRawArgumentString` (`:130-139`, `lib/args.mjs:76-128`), because Claude commands pass `"$ARGUMENTS"` as one quoted shell string. Consequence: a natural-language prompt containing `--write`/`--background`/`--model` tokens can be misparsed as flags, and matched/unmatched quotes change tokenization.
2. **`-C`/`--cwd` global alias** (`:141-149`) — every subcommand accepts `--cwd <path>`/`-C <path>`; `resolveCommandCwd` resolves against `process.cwd()` (`:151-153`) and `resolveCommandWorkspace` resolves the git root (`:155-157`, `lib/workspace.mjs:3-8`).

**Port implication:** call the runtime with an explicit argv array (or in-process functions), never the single-quoted-string form; strip routing flags before they reach `task` text.

### 1.2 Subcommands

Dispatch: `main()` switch at `:1031-1067`. Handlers and their parse config:

| Subcommand | Handler | Value options | Boolean options | Notes |
|---|---|---|---|---|
| `setup` | `handleSetup` `:215-239` | `cwd` | `json`, `enable-review-gate`, `disable-review-gate` | enable/disable are mutually exclusive (`:221-223`); writes `config.stopReviewGate` in state; always exits 0 unless arg error. |
| `review` | `handleReview`→`handleReviewCommand` `:712-760` | `base`, `scope`, `model`, `cwd` (alias `-m`→model) | `json`, `background`, `wait` | Native Codex reviewer only. **No focus text** — any positional is joined and rejected (`:271-284`). `--background`/`--wait` are accepted **but have no effect inside the CLI** (Claude's `Bash(run_in_background)` does the detaching). `--model` is accepted and silently passed to `thread/start`. |
| `adversarial-review` | `handleReviewCommand` `:1038-1042` | same as review | same | Steerable: positional focus text is allowed and interpolated into the prompt. |
| `task` | `handleTask` `:762-823` | `model`, `effort`, `cwd`, `prompt-file` (alias `-m`) | `json`, `write`, `resume-last`, `resume`, `fresh`, `background` | Prompt from `--prompt-file` → positionals joined with spaces (`:643-650`) → piped stdin (`lib/fs.mjs:35-40`). `--resume-last`/`--resume` alias; `--fresh` mutually exclusive (`:777-781`). `--write` selects `workspace-write` sandbox, default `read-only`. `--background` is the only flag that changes execution: detached worker. **`--wait` is NOT a task flag** — it would fall through into the prompt. |
| `transfer` | `handleTransfer` `:825-836` | `cwd`, `source` | `json` | Native Claude→Codex session import; Claude-specific (see §6/§7). |
| `status` | `handleStatus` `:883-908` | `cwd`, `timeout-ms`, `poll-interval-ms` | `json`, `all`, `wait` | With job-id: single-job snapshot; `--wait` polls until finished or timeout (defaults **240 000 ms**, poll **2 000 ms**; `:69-70, 318-334`). Without job-id: repo snapshot; `--wait` rejected (`:902-904`). `--all` only lifts the recent-jobs cap (session filter still applies — `lib/job-control.mjs:216`). |
| `result` | `handleResult` `:910-926` | `cwd` | `json` | Latest finished (session-scoped when session id present) or exact/prefix job id. |
| `cancel` | `handleCancel` `:963-1022` | `cwd` | `json` | Exact/prefix id, or the single active job of the current session; interrupt + `terminateProcessTree` + mark `cancelled`. |
| `task-resume-candidate` | `handleTaskResumeCandidate` `:928-961` | `cwd` | `json` | Internal helper for `/codex:rescue` — reports `{available, sessionId, candidate}` so Claude can ask "continue vs new thread". |
| `task-worker` | `handleTaskWorker` `:838-881` | `cwd`, `job-id` | — | **Internal** detached-worker entry, not user-facing. Reads the stored job's `request` payload and runs it. |
| `help`/`--help`/none | `printUsage` | — | — | Usage text lists only the 8 user-facing subcommands (`:75-89`). |

`parseArgs` semantics (`lib/args.mjs:1-74`): `--key=value` and `--key value`; unknown `--flag` becomes a positional (this is how focus text reaches `adversarial-review`, and how accidental unknown flags can leak into `task` prompts); `--` starts passthrough.

### 1.3 Output contract

- `outputResult(value, asJson)` (`:91-97`): JSON mode → `console.log(JSON.stringify(value, null, 2))`; human mode → `process.stdout.write(value)` (rendered markdown-ish text).
- Progress reporting at runtime goes to **stderr** in human mode (`createTrackedProgress({stderr: !options.json})` at `:658-663`; reporter `lib/tracked-jobs.mjs:117-132` prints `[codex] <message>`), and is suppressed in `--json` mode. Errors always go to stderr via the top-level catch (`:1069-1073`), plain text, exit code 1.
- One and only one document on stdout per invocation: a JSON object (job payload) or a rendered markdown block. Background launch JSON includes `logFile`; human mode prints one sentence.

### 1.4 Exit codes

| Situation | Exit |
|---|---|
| Success | `0` |
| Any thrown error (bad scope, no resume thread, unknown job, no task text, not a git repo, codex missing, …) | `1` (`:1069-1073`) |
| Foreground review/task whose Codex turn/review did not finish `completed` | review/task exit status = `execution.exitStatus` = `0` or `1`, propagated by `runForegroundCommand` (`:658-669`; status computed in `lib/codex.mjs:754-756`: `finalTurn.status === "completed" ? 0 : 1`) |
| Background launch | `0` (work continues detached) |
| `status --wait` timeout | `0`, payload `waitTimedOut: true` (`:329-333`) |
| `setup` when *not ready* | `0` (readiness is data, not exit code) |
| Codex turn failed but app-server returned a final message | rendered, exit `1` |

### 1.5 Job ids / machine readability

- Ids: `<prefix>-<base36 timestamp>-<6 base36 chars>` via `generateJobId` (`lib/state.mjs:124-127`); prefixes `review`, `task`. Examples from live run: `task-mvf4ii4s-mqd201`, `review-mvf4icem-i0ub92`.
- Generation happens **before** execution (`createCompanionJob`, `:567-578`), so ids are stable and available in all payloads.
- JSON payloads are the machine-readable contract (`jobId`, `threadId`, `turnId`, status, logFile, rendered/result). Human outputs embed the raw id and `/codex:*` follow-up hints (patch points in §7).
- Job references accept exact id or **unique prefix**; ambiguous prefixes throw; preview/status/result/cancel all use `matchJobReference` (`lib/job-control.mjs:191-211`).

### 1.6 Representative output samples (live, against `tests/fake-codex-fixture.mjs`)

Raw log of the full sample matrix: `/tmp/codex-samples/samples.txt` (regenerated per §8.4). Key shapes:

`setup --json` (exit 0):
```json
{
  "ready": true,
  "node": { "available": true, "detail": "v26.12.0" },
  "npm": { "available": true, "detail": "11.20.0" },
  "codex": { "available": true, "detail": "codex-cli test; advanced runtime available" },
  "auth": {
    "available": true, "loggedIn": true,
    "detail": "ChatGPT login active for test@example.com",
    "source": "app-server", "authMethod": "chatgpt", "verified": true,
    "requiresOpenaiAuth": true, "provider": "openai"
  },
  "sessionRuntime": { "mode": "direct", "label": "direct startup", "detail": "No shared Codex runtime is active yet. The first review or task command will start one on demand.", "endpoint": null },
  "reviewGateEnabled": false,
  "actionsTaken": [],
  "nextSteps": ["Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop."]
}
```

`review` (human, exit 0; progress went to stderr):
```
# Codex Review

Target: working tree diff

Reviewed uncommitted changes.
No material issues found.
```
stderr:
```
[codex] Starting Codex review thread.
[codex] Thread ready (thr_2).
[codex] Turn started (turn_2).
[codex] Reviewer started: current changes
[codex] Review output captured.
[codex] Reviewer finished.
[codex] Turn completed.
```

`review --json` payload:
```json
{
  "review": "Review",
  "target": { "mode": "working-tree", "label": "working tree diff", "explicit": false },
  "threadId": "thr_1",
  "sourceThreadId": "thr_1",
  "codex": { "status": 0, "stderr": "", "stdout": "Reviewed uncommitted changes.\nNo material issues found.", "reasoning": [] }
}
```

`adversarial-review` (human, exit 0):
```
# Codex Adversarial Review

Target: working tree diff
Verdict: needs-attention

One adversarial concern surfaced.

Findings:
- [high] Missing empty-state guard (src/app.js:4-6)
  The change assumes data is always present.
  Recommendation: Handle empty collections before indexing.

Next steps:
- Add an empty-state test.
```
`adversarial-review --json` adds `context.{repoRoot,branch,summary}`, `result` (parsed object), `rawOutput`, `parseError`, `reasoningSummary` (`:422-441`).

`task "investigate the failing build"` (human, exit 0) — **the raw final agent message is the entire stdout** (`lib/render.mjs:315-323`):
```
Handled the requested task.
Task prompt accepted.
```

`task --json`:
```json
{ "status": 0, "threadId": "thr_6", "rawOutput": "Handled the requested task.\nTask prompt accepted.", "touchedFiles": [], "reasoningSummary": [] }
```

`task --background --json` (exit 0 immediately):
```json
{
  "jobId": "task-mvf4ii3s-mqd201",
  "status": "queued",
  "title": "Codex Task",
  "summary": "investigate the failing test",
  "logFile": "/var/folders/…/T/codex-companion/repo-2d3e3ec8082f9f68/jobs/task-mvf4ii3s-mqd201.log"
}
```
Human equivalent: ``Codex Task started in the background as <id>. Check /codex:status <id> for progress.`` (`:556-558`).

`status <id> --wait --json` → `{workspaceRoot, job:<enriched job> , waitTimedOut:false, timeoutMs}`. Enriched job = stored record + `kindLabel`, `progressPreview` (last 4 log lines), `elapsed`, `duration`, `phase` (`lib/job-control.mjs:161-181`).

`result <id>` (human) appends the Codex thread breadcrumb when a thread exists (`lib/render.mjs:390-446`):
```
Handled the requested task.
Task prompt accepted.

Codex session ID: thr_7
Resume in Codex: codex resume thr_7
```
`result --json` → `{ job: <enriched>, storedJob: <raw job file incl. request/result/rendered> }`.

`status` (human, exit 0):
```
# Codex Status

Session runtime: shared session
Review gate: disabled

Latest finished:
- task-mvf4ii3s-mqd201 | completed | rescue | Codex Task
  Summary: Handled the requested task.
  Phase: done
  Duration: 1s
  Codex session ID: thr_7
  Resume in Codex: codex resume thr_7

Recent jobs:
- …
```
Machine form (`status --json`) = `{ workspaceRoot, config:{stopReviewGate}, sessionRuntime, running:[], latestFinished, recent:[], needsReview }`.

`cancel <id> --json` → `{ jobId, status:"cancelled", title, turnInterruptAttempted, turnInterrupted }`.

`transfer --json` (needs a Claude JSONL under `~/.claude/projects`):
```json
{ "threadId": "thr_8", "resumeCommand": "codex resume thr_8", "sourcePath": "/…/.claude/projects/-repo/sess-sample.jsonl", "sessionId": "sess-sample" }
```

`task-resume-candidate --json`:
```json
{ "available": true, "sessionId": null, "candidate": { "id": "task-…", "status": "completed", "title": "Codex Task", "summary": "…", "threadId": "thr_6", "completedAt": "…", "updatedAt": "…" } }
```

Error sample (`review --scope staged`, exit 1): stderr only —
```
Unsupported review scope "staged". Use one of: auto, working-tree, branch, or pass --base <ref>.
```
Unknown job (`cancel task-nope`, exit 1): `No job found for "task-nope". Run /codex:status to list known jobs.`

---

## 2. State & data-dir layout

Implemented by `lib/state.mjs`; root selection `resolveStateDir(cwd)` (`state.mjs:29-44`):

```
<root>/
  <repo-slug>-<sha256(canonicalWorkspaceRoot)[0:16]>/
    state.json              # index + config, version 1
    broker.json             # only when shared broker exists (broker-lifecycle.mjs:13, 72-100)
    jobs/
      <jobId>.json          # full job record: request + result + rendered
      <jobId>.log           # timestamped progress/assistant/reasoning blocks
```

- `<root>` = `$CLAUDE_PLUGIN_DATA/state` when that env var is set, else `os.tmpdir()/codex-companion` (`state.mjs:9-10, 41-43`). **This is the main Claude-coupling in persistence.**
- `<repo-slug>` = `basename(workspaceRoot)` with non `[a-zA-Z0-9._-]` collapsed to `-`; hash = SHA-256 of `realpathSync(workspaceRoot)` first 16 hex chars (`state.mjs:29-44`). Canonicalization means symlinked paths share state.
- `workspaceRoot` = `git rev-parse --show-toplevel` or the cwd if not a git repo (`lib/workspace.mjs:3-8`).

`state.json` (version 1):
```json
{ "version": 1,
  "config": { "stopReviewGate": false },
  "jobs": [ { "id":"task-…", "kind":"task", "kindLabel":"rescue", "title":"Codex Task",
              "workspaceRoot":"/repo", "jobClass":"task", "summary":"…", "write":false,
              "createdAt":"ISO", "sessionId":"sess-…", "status":"completed", "phase":"done",
              "pid":null, "logFile":"…/jobs/task-….log", "startedAt":"ISO",
              "threadId":"thr_7", "turnId":"turn_8", "completedAt":"ISO" } ] }
```
- `MAX_JOBS = 50`, pruned by `updatedAt` descending; pruned jobs' `.json`/`.log` are deleted on save (`state.mjs:80-116`).
- `sessionId` is present only when `CODEX_COMPANION_SESSION_ID` was set when the record was created (`lib/tracked-jobs.mjs:60-68`).
- No locking: `loadState` → mutate → `saveState` is a read-modify-write with no flock/mutex (`state.mjs:58-122`). See risk §9.4.

Per-job JSON evolves through `runTrackedJob` (`lib/tracked-jobs.mjs:142-203`):

| Phase | Fields written |
|---|---|
| created (foreground or queued) | `id, kind, kindLabel, title, workspaceRoot, jobClass, summary, write, createdAt, sessionId?`; background adds `status:"queued", phase:"queued", pid, logFile, request` (`codex-companion.mjs:684-710`) |
| running | `status:"running", startedAt, phase:"starting", pid:process.pid, logFile`; progress updater patches `phase/threadId/turnId` on change (`tracked-jobs.mjs:70-115`) |
| completed/failed | `status, threadId, turnId, pid:null, phase:"done"|"failed", completedAt, result, rendered` + failure `errorMessage` |
| cancelled | `status:"cancelled", phase:"cancelled", pid:null, completedAt, cancelledAt, errorMessage:"Cancelled by user."` (`codex-companion.mjs:986-1011`) |

Log format: `[<ISO>] <message>` lines for progress; assistant messages, reasoning summaries and review output are appended as `\n[<ISO>] <title>\n<body>` blocks (`tracked-jobs.mjs:36-49, 117-132`). `status` shows the last 4 non-title log lines as `progressPreview` (`job-control.mjs:61-76`).

Job classes/kinds: `jobClass` ∈ `review|task`; `kind` ∈ `review|adversarial-review|task`; display `kindLabel` = `adversarial-review|review|rescue` (`codex-companion.mjs:560-578`, `job-control.mjs:27-47`).

Cross-session scoping (`CODEX_COMPANION_SESSION_ID`):
- when set: `status`/`result`/`cancel`(no id)/`task-resume-candidate`/`task --resume-last` only see jobs with matching `sessionId`; `status <id>`, `result <id>`, `cancel <id>` can still address other sessions' jobs (explicit id bypasses the filter — `job-control.mjs:191-308`, tests `runtime.test.mjs:1692-1738`).
- when unset: everything is visible; `--resume-last` falls back to Codex-side thread discovery (`thread/list` searchTerm `Codex Companion Task`, §5.1).

---

## 3. Broker / app-server architecture and lifecycle

### 3.1 Components

| File | Role |
|---|---|
| `lib/app-server.mjs` | JSON-RPC client for `codex app-server`. Two transports: `SpawnedCodexAppServerClient` (direct stdio child, `:183-276`) and `BrokerCodexAppServerClient` (Unix socket/named pipe, `:278-333`). Base class implements request/notification/error dispatch (`:57-181`), server-request rejection `-32601` (`:156-161`), exit propagation to pending requests (`:163-176`). |
| `scripts/app-server-broker.mjs` | Long-lived process that owns one `codex app-server` child and multiplexes JSONL clients over a local socket (`:48-247`). |
| `lib/broker-lifecycle.mjs` | Lazy spawn/reuse/teardown of the broker + `state/broker.json` persistence (`:113-209`). |
| `lib/broker-endpoint.mjs` | Endpoint string codec: `unix:<path>` / `pipe:\\\\?\\pipe\\<name>` (`:10-41`). |

Trust boundary: the broker is a **local single-user** socket; no auth. One broker per workspace-root state dir, shared by every CLI invocation and (in the source design) by every Claude session working on that repo. It exists because app-server is stdio-only and each `/codex:*` command is a separate Node process: without it every invocation would cold-start Codex and lose notification routing.

### 3.2 Connection selection (client side)

`CodexAppServerClient.connect(cwd, options)` (`app-server.mjs:335-353`):
1. If `options.brokerEndpoint` → use it.
2. Else `$CODEX_COMPANION_APP_SERVER_ENDPOINT` (`app-server.mjs:22, 339`).
3. Else if `reuseExistingBroker` → `loadBrokerSession(cwd)?.endpoint` only (no spawn).
4. Else → `ensureBrokerSession(cwd)` (spawns lazily).
5. If no broker endpoint resolved at all → direct stdio spawn. `disableBroker: true` forces direct.

Callers:
- `runAppServerReview`, `runAppServerTurn`, `findLatestTaskThread` use `withAppServer` → broker by default (`lib/codex.mjs:1008, 1101, 1168`).
- `getCodexAuthStatus` uses `reuseExistingBroker: true` so `setup` never starts a broker (`codex.mjs:942-945`).
- `interruptAppServerTurn` likewise reuses only (`codex.mjs:982`).
- `importExternalAgentSession` uses `withDirectAppServer` (`codex.mjs:644-651, 1067`).

**Retry/direct fallback** (`codex.mjs:613-642`): if a brokered request fails with `BROKER_BUSY_RPC_CODE` (-32001) or the broker socket is missing/refused (`ENOENT`/`ECONNREFUSED`), it closes the client and retries the whole operation against a **freshly spawned direct app-server**. This is how "busy" degrades into a private runtime; note it re-runs the operation body, including thread creation.

### 3.3 Broker lifecycle (`lib/broker-lifecycle.mjs`)

`ensureBrokerSession(cwd)` (`:113-171`):
1. `loadBrokerSession(cwd)` reads `<stateDir>/broker.json`; if present and a socket connect succeeds within 150 ms → reuse (`:102-117`).
2. If present but dead → `teardownBrokerSession` (kill pid if provided, unlink pid/log/socket, rmdir session dir) + `clearBrokerSession` (`:119-129, 173-209`).
3. Create session dir `fs.mkdtempSync(os.tmpdir()/cxc-)` (`:15-17`).
4. Endpoint: Unix `<sessionDir>/broker.sock`, or on Windows named pipe `<basename>-codex-app-server` (`broker-endpoint.mjs:10-17`).
5. Spawn **detached** `process.execPath scripts/app-server-broker.mjs serve --endpoint <e> --cwd <cwd> --pid-file <sessionDir>/broker.pid`, stdout+stderr appended to `<sessionDir>/broker.log`, env inherited (`:59-70`).
6. Wait up to 2 000 ms for socket connect (`:24-41, 149`); on failure teardown and return `null` (caller falls back to direct).
7. Save `broker.json` = `{endpoint, pidFile, logFile, sessionDir, pid}`.

### 3.4 Broker process semantics (`app-server-broker.mjs`)

- On start: writes pid file, connects one `CodexAppServerClient.connect(cwd,{disableBroker:true})` i.e. spawns `codex app-server` as child, registers a notification handler (`:40-46, 66-70, 116`).
- Serves newline-delimited JSON-RPC over the socket. Handled locally: `initialize` (replies `userAgent:"codex-companion-broker"`), `initialized` (ignored), `broker/shutdown` (reply, clean shutdown, exit 0) (`:146-164`).
- **Serialization:** one `activeRequestSocket` and one `activeStreamSocket` at a time (`:69-70`). Any request from another socket while either is set → JSON-RPC error `-32001 "Shared Codex broker is busy."` (`:170-182`).
- Streaming methods = `turn/start`, `review/start`, `thread/compact/start` (`:12`). Their socket keeps notification ownership; `activeStreamThreadIds` = requested thread + (for `review/start`) `result.reviewThreadId`; the stream ends when a `turn/completed` for a stream thread arrives (`:14-23, 84-100, 197-221`).
- Exception: `turn/interrupt` from a different socket is allowed while a stream is active and no request socket is occupied (`:170-195`) — this is how `/codex:cancel` interrupts someone else's running turn through the shared runtime.
- Notifications are forwarded verbatim to the current owner socket only; everyone else sees nothing (`:84-100`).
- Shutdown on `broker/shutdown`, SIGTERM, SIGINT: end sockets, close app-server client, close server, unlink Unix socket + pid file (`:102-114, 236-244`). `--cwd` defaults to `process.cwd()` (`:62`). Errors → stderr + exit 1 (`:249-252`).

### 3.5 Session lifecycle hook (broker teardown)

`scripts/session-lifecycle-hook.mjs`:
- `SessionStart` input `{session_id, transcript_path, cwd}` written to `$CLAUDE_ENV_FILE` as `export CODEX_COMPANION_SESSION_ID=…`, `export CODEX_COMPANION_TRANSCRIPT_PATH=…`, `export CLAUDE_PLUGIN_DATA=…` (`:35-40, 77-81`). This is how per-session scoping reaches later Bash invocations.
- `SessionEnd`: best-effort `broker/shutdown` over the endpoint (`sendBrokerShutdown`, `broker-lifecycle.mjs:43-57`), kill still-running jobs of the ending session and drop their records (`:42-75`), `teardownBrokerSession(...)` and `clearBrokerSession(cwd)` (`:83-114`). The broker is therefore **per Claude session in practice** (torn down at SessionEnd), despite living in per-repo state.

### 3.6 Notifications the client actually consumes

`captureTurn` installs a notification handler, buffers until `turn/start` returns a turn id, then applies (`lib/codex.mjs:490-611`):

| Notification | Handling |
|---|---|
| `thread/started` | registers thread id/name/agentNickname/agentRole in `threadLabels` |
| `thread/name/updated` | updates label |
| `turn/started` | records `threadTurnIds[threadId]=turn.id`; subagent thread turns tracked in `activeSubagentTurns`; progress events carry `threadId/turnId` only for the root thread |
| `item/started` | `enteredReviewMode`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch` → progress messages + phases |
| `item/completed` | `agentMessage` (last main-thread message = final answer; `phase==="final_answer"` triggers wait-for-subagents completion heuristic), `exitedReviewMode` (review text), `reasoning` (summary sections merged), `fileChange` (touched files), `commandExecution` |
| `error` | records `state.error`, progress "Codex error: …" |
| `turn/completed` | root thread → completion; subagent thread → mark drained and schedule inferred completion |

Completion is **robust to protocol drift**: if the root `turn/completed` never arrives but a `final_answer` message was seen and subagent/collab work drained, a 250 ms timer infers completion (`:346-394`; test `runtime.test.mjs:875-891`). Only deltas are opted out at `initialize` (`item/agentMessage/delta`, reasoning deltas — `app-server.mjs:33-42`), so no token-level streaming is consumed; progress is item-level.

### 3.7 Failure/exit modes

- app-server crash: pending requests reject with `codex app-server exited unexpectedly (signal …/exit …)` + aggregated stderr; turn capture rejects (`app-server.mjs:163-176, 209-218`).
- broker crash: broker client gets socket close → pending reject; next CLI invocation's `ensureBrokerSession` detects the dead socket and respawns.
- stderr surfaced in results: direct transport only — **broker transport never populates `client.stderr`**, so `codex.stderr`/`stderr` payload fields are empty for brokered runs; broker/app-server stderr lives in `<sessionDir>/broker.log`.

---

## 4. Review pipeline

### 4.1 Target selection (shared by both review types)

`resolveReviewTarget(cwd, {base, scope})` (`lib/git.mjs:135-191`):

| Input | Result |
|---|---|
| `--base <ref>` | `{mode:"branch", label:"branch diff against <ref>", baseRef, explicit:true}` (wins over `--scope`) |
| `--scope working-tree` | `{mode:"working-tree", label:"working tree diff", explicit:true}` |
| `--scope branch` | detect default branch (`origin/HEAD` → `main`/`master`/`trunk`, local or `origin/`) → branch target; error if undetectable |
| `--scope auto` (default) | dirty repo (staged+unstaged+untracked non-empty) → working-tree; clean → branch vs detected default branch |
| `--scope staged/unstaged/anything else` | error `Unsupported review scope "<x>". Use one of: auto, working-tree, branch, or pass --base <ref>.` |

Branch comparison: `buildBranchComparison` = `git merge-base HEAD <base>`, `commitRange=<mb>..HEAD`, `reviewRange=<base>...HEAD` (`git.mjs:69-76`). Requires a git repo (`ensureGitRepository`, `git.mjs:78-88`; errors "This command must run inside a Git repository." when not).

### 4.2 Native review (`/codex:review`, `review` subcommand)

`executeReviewRun` for `reviewName === "Review"` (`codex-companion.mjs:358-407`):
1. `ensureCodexAvailable` (spawnSync `codex --version` and `codex app-server --help`; `lib/codex.mjs:886-904`).
2. `resolveReviewTarget`.
3. `validateNativeReviewRequest`: rejects any focus text with a redirect message to adversarial-review; maps target → Codex native `ReviewTarget`: `working-tree → {type:"uncommittedChanges"}`, `branch → {type:"baseBranch", branch:<baseRef>}` (`codex-companion.mjs:259-284`).
4. `runAppServerReview` (`codex.mjs:1002-1056`): `thread/start` `{cwd, model, approvalPolicy:"never", sandbox:"read-only", serviceName:"claude_code_codex_plugin", ephemeral:true}` (no thread name); then `review/start` `{threadId, delivery:"inline", target}` inside `captureTurn`.
5. Result: `reviewText` comes from the `exitedReviewMode` item (not the agent message); status from final turn; reasoning summaries merged from `reasoning` items.
6. Payload `{review:"Review", target, threadId, sourceThreadId, codex:{status,stderr,stdout:reviewText,reasoning}}`; rendered by `renderNativeReviewResult` (`render.mjs:288-313`): `# Codex Review`, `Target: …`, then Codex's own review text verbatim (or "completed without any stdout output"/"failed"), optional `Reasoning:` bullets, stderr fenced.

There is **no output schema** and no client-side output validation for native review: the verdict/body is Codex's native review markdown.

### 4.3 Adversarial review (`/codex:adversarial-review`)

`executeReviewRun` else-branch (`codex-companion.mjs:409-457`):
1. `collectReviewContext(cwd, target)` (`git.mjs:300-347`):
   - working-tree: status, staged diff, unstaged diff, untracked file contents (text only, ≤24 KiB/file, dirs/binaries/broken symlinks noted and skipped).
   - branch: `git log --oneline --decorate <commitRange>`, `git diff --stat`, full branch diff.
   - Inline size gates: include diffs only if changed files ≤ **2** and diff bytes ≤ **256 KiB** (`git.mjs:7-9, 300-334`); otherwise "self-collect" mode where only status/stats/changed-file list/untracked text is sent and the prompt tells Codex to inspect the diff itself with read-only git commands (`git.mjs:292-298, 335-346`).
2. Prompt = `prompts/adversarial-review.md` with `{{REVIEW_KIND}}` (`Adversarial Review`), `{{TARGET_LABEL}}`, `{{USER_FOCUS}}` (`No extra focus provided.`), `{{REVIEW_COLLECTION_GUIDANCE}}`, `{{REVIEW_INPUT}}` (`codex-companion.mjs:241-250`, `lib/prompts.mjs`).
3. `runAppServerTurn` with `{prompt, model, sandbox:"read-only", outputSchema:<schemas/review-output.schema.json>}` — `persistThread`/`threadName` are not passed, so the thread is ephemeral read-only (`:411-417`).
4. `parseStructuredOutput(result.finalMessage)` — `JSON.parse`, on failure `{parsed:null, parseError, rawOutput}` (`codex.mjs:1188-1213`).
5. Payload adds `context {repoRoot,branch,summary}`, `codex`, `result`, `rawOutput`, `parseError`, `reasoningSummary`.
6. Rendering `renderReviewResult` (`render.mjs:211-286`): degrades gracefully if JSON invalid/shape-invalid (prints parse/validation error + raw final message fenced); on success client-side shape validation requires `verdict:string`, `summary:string`, `findings:[]`, `next_steps:[]`; findings normalized (defaults `severity:"low"`, `title:"Finding N"`, `body:"No details provided."`, `file:"unknown"`), sorted critical→high→medium→other; output:
```
# Codex Adversarial Review
Target: <label>
Verdict: <verdict>
<summary>
Findings:
- [<severity>] <title> (<file>:<start>-<end>)
  <body>
  Recommendation: <recommendation>
Next steps:
- <step>
Reasoning:            # only if reasoning captured
- <section>
```

Schema (`schemas/review-output.schema.json`): object, additionalProperties false, required `verdict` (enum `approve|needs-attention`), `summary` (minLength 1), `findings` (items: severity critical|high|medium|low, title, body, file, line_start/line_end integer ≥1, confidence number 0–1, recommendation string), `next_steps` (string[] minLength 1). Note the schema requires `confidence` but the renderer does not display it.

### 4.4 Review job records

Both review types create a tracked `review` job (`codex-companion.mjs:730-752`) → job id `review-*`; title "Codex Review"/"Codex Adversarial Review"; summary is first meaningful line of output (or parse error/failure). Progress (human mode → stderr, always → job log) includes "Starting Codex review thread.", "Thread ready (thr_x).", "Turn started (turn_x).", reviewer/item messages, reasoning summaries, final output block.

---

## 5. Rescue/delegate pipeline (`task`)

### 5.1 Thread selection / resume

`executeTaskRun` (`codex-companion.mjs:461-530`), `resumeThreadId` chosen when `--resume-last|--resume`:
1. `resolveLatestTrackedTaskThread(workspaceRoot, {excludeJobId})` (`:336-356`): newest job by `updatedAt` in the **current session** (if session id set); if an active (`queued|running`) task exists → error `Task <id> is still running. Use /codex:status before continuing it.`; else first finished task with a `threadId` → resume it.
2. If no tracked thread **and** a session id is set → error `No previous Codex task thread was found for this repository.` (prevents cross-session resume; tests `runtime.test.mjs:573-670`).
3. If no session id at all → `findLatestTaskThread(workspaceRoot)` via app-server `thread/list {cwd, limit:20, sortKey:"updated_at", sourceKinds:["appServer"], searchTerm:"Codex Companion Task"}` and pick a thread whose name starts with the prefix (`codex.mjs:1162-1182`).

Prompt source (`:643-656`): `--prompt-file` (read relative to cwd) > positionals joined > piped stdin. `--resume-last` with no prompt uses `DEFAULT_CONTINUE_PROMPT` = "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved." (`codex.mjs:49-50, 1127-1130`). No prompt and no resume → error `Provide a prompt, a prompt file, piped stdin, or use --resume-last.`

### 5.2 Model / effort / sandbox / thread parameters

- Model alias: `spark → gpt-5.3-codex-spark` (`codex-companion.mjs:72, 103-112`); any other `--model` passed through literally.
- Effort validation: only `none|minimal|low|medium|high|xhigh` accepted, lower-cased (`:71, 114-128`); invalid → error listing the six values.
- Sandbox: `--write` → `"workspace-write"`, else `"read-only"` (`:491`).
- `approvalPolicy: "never"` always (`codex.mjs:63-83`).
- New task thread: `ephemeral:false` (persisted so it can be resumed/shown in Codex), `thread/start` + best-effort `thread/name/set` `"Codex Companion Task: <prompt excerpt ≤56 chars>"`; `thread/name/set` "unknown method/variant" errors are suppressed for older CLIs (`codex.mjs:107-110, 732-748`).
- Resume: `thread/resume {threadId, cwd, model, approvalPolicy:"never", sandbox}` (`codex.mjs:74-83, 750-752`).
- Turn: `turn/start {threadId, input:[{type:"text",text:prompt,text_elements:[]}], model, effort, outputSchema:null}` (`codex.mjs:86-88, 1132-1144`).
- Result: `finalMessage = last main-thread agentMessage`; `touchedFiles` collected from completed `fileChange` items (`codex.mjs:126-136, 1146-1159`); status from final turn; `renderTaskResult` returns the raw final message (or a failure message) (`render.mjs:315-323`); job summary = first meaningful line.

### 5.3 Foreground vs background

Foreground (`runForegroundCommand`, `:658-669`): creates job + log file, `runTrackedJob` writes running/completed records, prints rendered/JSON, sets exit code.

Background (`:671-710`):
1. Create job record and log file; append "Queued for background execution.".
2. Spawn **detached** `process.execPath scripts/codex-companion.mjs task-worker --cwd <cwd> --job-id <id>` with inherited env, `stdio:"ignore"`, `windowsHide`, `detached:true`, `unref()`.
3. Write queued record `{...job, status:"queued", phase:"queued", pid:child.pid, logFile, request:{cwd,model,effort,prompt,write,resumeLast,jobId}}` to the job file + state index.
4. Print launch payload `{jobId,status,title,summary,logFile}` / human sentence.
5. `task-worker` reads the stored job, requires `.request`, creates progress, `runTrackedJob` around `executeTaskRun` (`:838-881`).
   - Race noted: the file is written *after* spawn; the child must boot Node before reading, but there is no readiness handshake. In practice node startup > file write, but a failure leaves a queued job forever (status/`--wait` will time out). Consider writing the queued record **before** spawning in the port.

`status --wait <id>` polls `buildSingleJobSnapshot` every 2 s up to 240 s (configurable), returns `waitTimedOut` (no error).

### 5.4 Cancellation

`handleCancel` (`:963-1022`):
1. Resolve active job (exact/prefix id, or the single active job of the current session; multiple → "Multiple Codex jobs are active. Pass a job id to /codex:cancel.").
2. Read stored job file for `threadId/turnId` (`storedJob.threadId ?? job.threadId`).
3. `interruptAppServerTurn(cwd,{threadId,turnId})` (`codex.mjs:960-1000`): returns attempted:false when either id missing or Codex unavailable; connects with `reuseExistingBroker:true`, sends `turn/interrupt {threadId,turnId}`. If no broker env/state exists this may spawn a direct app-server that doesn't own the turn → interrupt fails softly (`interrupted:false`, detail kept).
4. `terminateProcessTree(job.pid)` — Unix: `kill(-pid, SIGTERM)` (process group; requires detached child), fallback `kill(pid)`; Windows `taskkill /PID <pid> /T /F` (`lib/process.mjs:57-118`).
5. Append log "Cancelled by user."; write job file + index record `cancelled`; payload `{jobId,status,title,turnInterruptAttempted,turnInterrupted}`.

Worker processes killed by group signal die mid-run; their job file may be overwritten to `cancelled` after the worker's own record write (last-writer-wins).

### 5.5 Setup / auth preflight

`buildSetupReport` (`:182-213`): spawnSync `node --version`, `npm --version`, codex availability (`codex --version` + `codex app-server --help`), auth via app-server `account/read {refreshToken:false}` + `config/read {includeLayers:false,cwd}` (`codex.mjs:868-884`), then:
- `account.type==="chatgpt"` → loggedIn true, verified true, detail with email;
- `account.type==="apiKey"` → loggedIn true, verified false (unverified);
- else `requiresOpenaiAuth===false` → loggedIn true ("provider configured and does not require OpenAI authentication");
- else not logged in, `provider`/`providerLabel` resolved from `config.model_provider` + `config.model_providers` (`codex.mjs:758-866`).
`ready = node.available && codex.available && auth.loggedIn` (npm not required). `nextSteps` suggests `npm install -g @openai/codex`, `!codex login`, device-auth/API-key fallbacks, and the review gate toggle (`:190-201`). `getSessionRuntimeStatus` reports `shared` when a broker endpoint exists (env or `broker.json`) else `direct` (`codex.mjs:906-923`).

**Port note:** `task`/`review` do **not** preflight auth; they run and surface Codex's auth error (deliberately, so Codex can refresh an expired session — tests `runtime.test.mjs:178-194`). Only `setup` checks auth.

---

## 6. Claude-Code coupling table

Sources: grep of `plugins/`, plus the DSH Host Service/Event catalog queried live (2026-10-19). "DSH replacement" names are the exact service signatures as inspected; the owning DSH-side engineer decides final placement.

| # | Coupling (file:line) | Claude Code assumption | DSH replacement needed |
|---|---|---|---|
| 1 | `commands/*.md:1-6` | Slash commands (`/codex:*`), YAML frontmatter `description/argument-hint/allowed-tools/disable-model-invocation`, `$ARGUMENTS`, `!`bash-exec``, markdown body is model instructions | `ctx.commands.register({name, description, input:{hint}, handler})`; `CommandInvocation.rawInput` replaces `$ARGUMENTS`; run the runtime from the handler (no `!` expansion). Command names are DSH-owned (e.g. `codex-review`); no slash prefix in `name`. |
| 2 | `commands/*.md` (`AskUserQuestion`), `commands/rescue.md:23-37`, `review.md:30-32` | Claude asks the user wait vs background and resume vs fresh | `ctx.userQuestions.ask(...)` / `userQuestions/request` event; or configuration default. |
| 3 | `commands/rescue.md:7-8`, `agents/codex-rescue.md`, `commands/review.md:51-59` | `Agent` tool with `subagent_type:"codex:codex-rescue"`, `Bash(..., run_in_background:true)`, `BashOutput`, "subagent is a thin forwarder" | Rescue is a normal `ctx.tools.register` tool (model calls it directly); background via `ctx.jobs.start`/`ctx.jobs.wait`/`ctx.jobs.kill` or the runtime's own detached worker; drop the subagent forwarding layer. |
| 4 | `${CLAUDE_PLUGIN_ROOT}` in every command/hook/skill/agent (e.g. `commands/review.md:45`, `hooks/hooks.json:9,20,31`) | Plugin install directory exported by Claude | In-process `import.meta.url`/plugin `ctx.baseDir`-style resolution; vendored asset root relative to the bundle. |
| 5 | `lib/state.mjs:9` `CLAUDE_PLUGIN_DATA` | Durable per-plugin data dir supplied by Claude | Plugin `Config` field (e.g. `dataDir`) resolved to a DSH profile data path; keep fallback temp dir. |
| 6 | `lib/tracked-jobs.mjs:6` `CODEX_COMPANION_SESSION_ID`; consumed in `codex-companion.mjs:294-304, 336-356, 928-961`, `lib/job-control.mjs:15-25` | Session id injected into every Bash env by `SessionStart` hook (`scripts/session-lifecycle-hook.mjs:77-81`) | Pass `agent.id` (SessionId) explicitly from tool/command handlers; persist it on job records; filter by it. No env injection needed. |
| 7 | `scripts/session-lifecycle-hook.mjs` + `hooks/hooks.json:4-25` | `SessionStart`/`SessionEnd` hooks + `$CLAUDE_ENV_FILE` exports + `CLAUDE_PROJECT_DIR` (`stop hook:144`) | `agent/created` and `agent/disposed` events (or plugin effect lifecycle); env injection replaced by context parameters. SessionEnd cleanup (kill jobs, shut broker) maps to plugin/agent disposal. |
| 8 | `scripts/stop-review-gate-hook.mjs` + `hooks/hooks.json:26-36` + `prompts/stop-review-gate.md` | Claude `Stop` hook: stdin JSON `{session_id,cwd,last_assistant_message}`, stdout `{"decision":"block","reason":…}` blocks stopping; 900 s hook timeout | No direct blocking-stop contract in DSH: `agent/turn-stopping` is serial and returns `Promise<void>` (no decision). Candidate replacements: `agent/pre-step` waterfall (reject/replace next step) or the `claudeCodeMods` mods bridge (`turn.complete` hook, `TurnCompleteResult{text}`). **Decision needed**; recommended: drop gate in v1, expose explicit review commands only. |
| 9 | `lib/claude-session-transfer.mjs:7-8` (`~/.claude/projects`), `:20-44`, `commands/transfer.md`, README `transfer` section | Claude Code JSONL transcripts under `~/.claude/projects`; Codex's `externalAgentConfig/import` "SESSIONS" migration (Claude format) | **Drop in v1.** DSH has no `~/.claude/projects` transcript contract; re-import path would need a DSH-session→Codex exporter (unverified if Codex supports another source). |
| 10 | `lib/app-server.mjs:19-20, 26-30` | Reads `../../.claude-plugin/plugin.json`; clientInfo `title:"Codex Plugin", name:"Claude Code"` | Vendor `.claude-plugin/plugin.json` next to scripts (keeps path valid) or patch to read bundle manifest; clientInfo → `{name:"DeepSeek Harness", title:"Codex Plugin", version:<bundle version>}`. |
| 11 | `lib/codex.mjs:47` `SERVICE_NAME="claude_code_codex_plugin"` | Analytics/thread `serviceName` tag | Change to a DSH constant (or keep; it is only a label/metadata, schema accepts any string). |
| 12 | `lib/render.mjs:114,116,149,152,155-156,462`; `codex-companion.mjs:199,274,280,343,557`; `lib/job-control.mjs:210,247,271,275,300`; `lib/codex.mjs:255,1005,1061,1098,1165`; `stop-review-gate-hook.mjs:66,75,94,116,126,137,151` | Human-facing hints reference `/codex:*` commands and `!codex login` | Rewrite hint strings to the DSH command/tool names chosen by the Lead (single constants module recommended so tests can assert one place). |
| 13 | `skills/codex-cli-runtime/SKILL.md`, `skills/codex-result-handling/SKILL.md` | Instructions for the Claude rescue subagent / Claude result presentation | Fold into DSH tool descriptions (`tools` skill guidance) — content is still useful (verbatim forwarding, don't auto-fix review findings, write-mode default); drop the SKILL frontmatter/`user-invocable:false`. |
| 14 | `skills/gpt-5-4-prompting/**` | Model-version named skill (`gpt-5.4`), XML prompt blocks | Keep the content as a DSH skill or prompt appendix, renamed model-agnostically (e.g. `codex-prompting`). No code dependency. |
| 15 | `package.json`, `tsconfig.app-server.json`, `scripts/bump-version.mjs`, `.github/workflows/pull-request-ci.yml`, `.claude-plugin/marketplace.json` | Claude marketplace/CI/dev tooling | Drop; DSH bundle gets its own package manifest/build. Keep `package.json`-style `engines.node>=18.18` note in docs. |
| 16 | Env: `CODEX_HOME`, `HOME`, `PATH` (`codex.mjs:653-655`, `app-server.mjs:190`, `process.mjs:38-51`) | Local Codex CLI install + auth/config state | Keep; DSH must ensure subprocess env includes user PATH and writable `CODEX_HOME` (§9.2), or expose `codexBinary`/`codxHome` Config overrides. |
| 17 | `lib/process.mjs:57-118` (`terminateProcessTree`) | Unix process-group kill assumes detached child; Windows taskkill | Reuse as-is; in-process implementation would instead abort the child handle / `ctx.subprocess`. |
| 18 | `hooks/hooks.json` timeout model (5 s/900 s) and hook stdin JSON | Claude hook protocol | DSH events (`agent/created`, `agent/disposed`) don't take stdin JSON; SessionStart/End payloads differ (`SessionStartInput{cwd,surface,isInteractive}` exists only in the mods bridge, not Cordis events). |

---

## 7. File-by-file port map

Recommended layout after vendoring (preserve relative paths so `ROOT_DIR`/manifest URLs keep working):

```
plugins/dsh-codex/                 # new DSH bundle
  index.ts|js                      # Cordis entry: config schema, tools, commands, events  (NEW)
  runtime/                         # vendored from codex-plugin-cc/plugins/codex (layout preserved)
    scripts/{codex-companion.mjs, app-server-broker.mjs, lib/*, *.hook.mjs}
    prompts/{adversarial-review.md, stop-review-gate.md}
    schemas/review-output.schema.json
    .claude-plugin/plugin.json     # only if app-server.mjs:19 left unpatched
  docs/…
```

| File | Verdict | Patch points / notes |
|---|---|---|
| `scripts/lib/git.mjs` (347 l) | **VERBATIM** | Pure git + fs; no Claude deps. `shell:false` is already hardened. Keep. |
| `scripts/lib/fs.mjs` (40 l) | **VERBATIM** | `readStdinIfPiped` still fine for CLI mode; unused if in-process. |
| `scripts/lib/args.mjs` (128 l) | **VERBATIM** | Optional: drop `splitRawArgumentString` if the tool layer never passes a single raw string. |
| `scripts/lib/prompts.mjs` (13 l) | **VERBATIM** | Template loader; keep. |
| `scripts/lib/workspace.mjs` (9 l) | **VERBATIM** | git-root fallback. |
| `scripts/lib/process.mjs` (135 l) | **VERBATIM** | Keep for pid/process-tree kill and binary probes. |
| `scripts/lib/broker-endpoint.mjs` (41 l) | **VERBATIM** | Needed only if the custom broker is kept. |
| `scripts/lib/app-server.mjs` (354 l) | **PATCH (small)** | `:19-20` hard-coded `../../.claude-plugin/plugin.json` (vendor that file or read bundle manifest / default version); `:26-30` `DEFAULT_CLIENT_INFO` name/title → DSH; `:22` broker endpoint env name (optional rename); `:190` spawn `codex` → configurable binary path; consider adding a 0.163.0 `--listen unix://` transport variant (§9.3). Optional: increase broker connect timeout `lib/broker-lifecycle.mjs:24-41, 149` (2 s may be tight for a cold 0.163.0 app-server). |
| `scripts/lib/codex.mjs` (1219 l) | **PATCH (small)** | `:47` `SERVICE_NAME`; `:255,1005,1061,1098,1165` `/codex:setup` hint text; `:274,280` review redirect hints; optionally add `model/list` validation for the `spark` alias (`:72` lives in companion) and a minimum-CLI-version probe in `getCodexAvailability` (`:886-904`). No protocol changes required for 0.163.0 (§9.1). |
| `scripts/lib/state.mjs` (191 l) | **PATCH** | `:9-10` replace `CLAUDE_PLUGIN_DATA`/temp fallback with a configured data dir (keep `state/<slug>-<hash16>` layout and `MAX_JOBS=50`). Add serialization/mutex around `loadState`→`saveState` (§9.4). |
| `scripts/lib/tracked-jobs.mjs` (204 l) | **PATCH** | `:6,60-68` session id: accept it as a parameter instead of reading env; `:142-203` keep record lifecycle. |
| `scripts/lib/job-control.mjs` (308 l) | **PATCH** | Session id parameter (`:15-25`); rewrite `/codex:*` hint strings (`:210,247,271,275,300`); everything else portable. |
| `scripts/lib/render.mjs` (465 l) | **PATCH (strings only)** | Rewrite command hints `:114,116,149,152,155-156,462`; output formats otherwise portable and covered by tests. |
| `scripts/lib/broker-lifecycle.mjs` (209 l) | **PATCH (small)** | Env names `:11-12`; `:59-70` spawn `process.execPath` + script path (works when vendored); `:72-100` `broker.json` stays; consider longer readiness timeout. |
| `scripts/codex-companion.mjs` (1073 l) | **PATCH** | This is the CLI façade. Needed: `:24` remove transfer import (drop command), `:67-73` ROOT_DIR/schema/stop-marker (marker only used by stop gate), `:83` usage line for transfer, `:294-304,336-356,928-961` session id source, `:532-558,560-578`/`:182-213` hint strings, `:616-641` transfer code path, `:643-656` prompt reader, `:825-836` transfer handler, `:1046-1047` dispatch entry, `:671-710` optionally write queued record before spawn, plus a programmatic export (currently only `main()`; either refactor to export handlers or invoke via `child_process`/`process.argv` shim). If the DSH tool layer calls the CLI as a subprocess, keep the CLI as-is and only patch env/hints. |
| `scripts/app-server-broker.mjs` (252 l) | **KEEP (patch-free) or DROP** | Keep for v1: known-good serialized shared runtime, no Claude coupling. Drop only if the DSH port adopts Codex 0.163.0's native `codex app-server --listen unix://`/`daemon` after verifying multi-client semantics (§9.3). |
| `scripts/session-lifecycle-hook.mjs` (133 l) | **ADAPT / DROP as script** | Logic to preserve: broker shutdown + per-session job cleanup at session end (`:42-114`). Re-implement as Cordis effect disposal / `agent/disposed` listener; env-export mechanism (`:35-40`) is Claude-only. |
| `scripts/stop-review-gate-hook.mjs` (184 l) | **DROP (recommended) or ADAPT** | Blocking-stop semantics unavailable in DSH; keep only if a gate design is chosen (see §6 #8). |
| `hooks/hooks.json` (38 l) | **DROP** | Replaced by DSH plugin event/effect wiring. |
| `commands/*.md` (8 files) | **DROP as markdown; TRANSLATE semantics** | Each file's semantics become a `ctx.commands.register` definition (or tool description): `review.md`, `adversarial-review.md`, `rescue.md`, `status.md`, `result.md`, `cancel.md`, `setup.md`, `transfer.md` (drop transfer). Preserve review-only/no-autofix constraints, wait-vs-background recommendation logic, resume-vs-fresh logic, model/effort pass-through, and verbatim-output rules. |
| `agents/codex-rescue.md` (46 l) | **DROP / TRANSLATE** | Semantics → `codex_task` tool description: default write mode, strip routing flags, one call, return stdout verbatim, no follow-up work. |
| `skills/codex-cli-runtime/SKILL.md` | **DROP (fold into tool description)** | |
| `skills/codex-result-handling/SKILL.md` | **DROP (fold into tool output rendering/description)** | |
| `skills/gpt-5-4-prompting/**` (422 l total) | **ADAPT (optional)** | Rename model-agnostic, ship as DSH skill content or embed in `codex_rescue` tool description. |
| `prompts/adversarial-review.md` (84 l) | **VERBATIM** | Only asset change: no path references. Keep XML contract exactly. |
| `prompts/stop-review-gate.md` (36 l) | **DROP with gate** | References a "previous Claude turn". |
| `schemas/review-output.schema.json` (87 l) | **VERBATIM** | Keep byte-identical so `outputSchema` behavior doesn't drift. |
| `.claude-plugin/plugin.json`, root `.claude-plugin/marketplace.json` | **DROP (or vendor plugin.json for `app-server.mjs:19` if unpatched)** | Replace with DSH bundle manifest/package.json. |
| `scripts/bump-version.mjs`, `tsconfig.app-server.json`, `package-lock.json`, CI workflow, README | **DROP** | Dev/release tooling; `.generated/app-server-types` isn't checked in and is only used for `tsc --noEmit` typechecking of `app-server.mjs`/`codex.mjs`. |
| `LICENSE` (Apache-2.0) + `NOTICE` | **COPY** | Vendoring OpenAI code requires keeping both files (root and `plugins/codex/` copies are identical). |
| `tests/fake-codex-fixture.mjs` + `helpers.mjs` | **REUSE** | Best asset for the port: a protocol-accurate app-server emulator. Repoint any internal paths if vendored, otherwise keep tests importing the original repo during transition. |
| `tests/*.test.mjs` | **ADAPT** | See §8.3. |

**Minimum coherent port =** vendored runtime (scripts + prompts + schema) + one Cordis entry that registers tools/commands + a small context shim that supplies `{cwd, workspaceRoot, sessionId, dataDir, codexBinary, env, signal}` + hint-string rewrite + data-dir/session patches. Everything else (daemon, DSH jobs integration, hooks, transfer) is opt-in.

---

## 8. Test status and adaptation plan

### 8.1 Commands and results (exact)

```bash
cd ~/Developer/codex-deepseek-plugin/codex-plugin-cc
node --version          # v26.12.0
npm --version           # 11.20.0
codex --version         # codex-cli 0.163.0
npm test                # script: node --test tests/*.test.mjs
```
Result (2026-10-19): `tests 91, suites 0, pass 91, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 81861.21`. No `node_modules` directory exists in the checkout and none is needed for `npm test` (tests use `node:test`, `node:assert`, builtins). `devDependencies` (`typescript`, `@types/node`) are only for `npm run build`/`check-version`; `npm run build` additionally needs `codex app-server generate-ts` output (`.generated/app-server-types`, generated by `prebuild`) and was **not** run (out of scope, would write into the source checkout).

CI (`.github/workflows/pull-request-ci.yml`): Ubuntu, Node 22, `npm ci`, `npm install -g @openai/codex`, `npm test`, `npm run build`. So the suite is expected to pass against the npm-installed Codex CLI too — but note **no test starts the real `codex` app-server**: every runtime test injects `installFakeCodex(binDir)` on PATH.

### 8.2 What the current tests cover

| File | Coverage |
|---|---|
| `runtime.test.mjs` (2259 l, ~60 tests) | setup readiness across auth/provider variants; native review; adversarial structured review incl. self-collect and base-branch targeting; reasoning capture/logging; task model/effort forwarding, `--resume`/`--fresh`/`--resume-last` routing and cross-session isolation; background worker + status/result; status table/phase/duration/`--wait` timeout; result rendering (structured, raw, session preference); cancel (pid kill, interrupt, cross-session id vs no-id); session hooks (env exports, SessionEnd cleanup); stop gate (block/allow/disabled/unavailable/stale-auth); lazy broker reuse (`appServerStarts===1`), setup/status broker reuse, `--cwd` handling; transfer happy path + unsupported/failed/outside-projects errors; auth error surfacing; arg quirks. |
| `commands.test.mjs` (225 l) | Content/contract of the Claude markdown commands, rescue/agent/skill prose, hooks.json, README. **Entirely Claude-format-specific — must be rewritten or deleted.** |
| `state.test.mjs` (105 l) | state dir location (tmp fallback, `CLAUDE_PLUGIN_DATA`), 50-job pruning + artifact deletion. |
| `render.test.mjs` (59 l) | degraded structured review rendering; stored-result thread breadcrumb. |
| `git.test.mjs` (212 l) | target resolution, base override, default-branch detection incl. shell-metachar branch names, inline/self-collect thresholds, untracked dirs/broken symlinks. |
| `process.test.mjs` (55 l) | Windows `taskkill` path (mocked). |
| `broker-endpoint.test.mjs` (22 l) | Unix vs Windows pipe endpoint codec. |
| `bump-version.test.mjs` (88 l) | repo version bump tooling — drop. |
| `fake-codex-fixture.mjs` (658 l) | Emulated `codex` binary: `--version`, `app-server --help`, `login status`, `login`, and a stdio JSONL app-server implementing `initialize`, `account/read`, `config/read`, `thread/start`(+`thread/started`), `thread/name/set`, `thread/list`, `thread/resume`, `externalAgentConfig/import`(+`/completed`, plus Claude-JSONL→thread + `$CODEX_HOME/external_agent_session_imports.json` ledger), `review/start` (+`enteredReviewMode`/`exitedReviewMode`), `turn/start`, `turn/interrupt`. Behaviors: `review-ok`, `logged-out`, `refreshable-auth`, `auth-run-fails`, `provider-no-auth`, `env-key-provider`, `api-key-account-only`, `config-read-fails`, `external-import-unsupported`, `external-import-fails`, `with-reasoning`, `with-subagent` (+`with-late-subagent-message`, `with-subagent-no-main-turn-completed`), `slow-task`, `interruptible-slow-task`, `adversarial-clean`, `invalid-json`. State in `fake-codex-state.json` (`threads`, `lastTurnStart{threadId,turnId,model,effort,prompt}`, `lastInterrupt`, `appServerStarts`). |

### 8.3 Adaptation plan for the port

1. **Keep the fake fixture as the port's contract test.** It is not Claude-specific; it pins notification ordering, review items, subagent/collab drains, interrupt, background slowness, and import ledger behavior. Repoint its script path and keep its state file for assertions.
2. **runtime.test.mjs**: mostly portable. Required edits: (a) import paths after vendoring; (b) replace `CODEX_COMPANION_SESSION_ID` env setup with whatever session-context injection the port uses (or keep the env shim during transition); (c) replace `SESSION_HOOK`/`STOP_HOOK` cases with DSH event/effect equivalents or drop gate/hook tests; (d) drop `transfer` tests (unless transfer is kept — strongly advise dropping); (e) setup/status assertions that reference `CLAUDE_PLUGIN_DATA` state dir → new data dir; (f) any `/codex:*` hint assertions.
3. **commands.test.mjs**: delete; replace with tests that assert the DSH command/tool schemas exist and their descriptions carry the safety rules (review-only, no auto-fix, verbatim output, write-by-default for rescue).
4. **state.test.mjs**: update data-dir env → config; add a concurrency test once a mutex is introduced (parallel `upsertJob` should not lose records).
5. **git/render/process/broker-endpoint tests**: keep; add path/import updates only.
6. **Drop** `bump-version.test.mjs` and any marketplace/CI assertions.
7. **Add (missing coverage, important for 0.163.0):**
   - a protocol-contract test that runs `codex app-server generate-json-schema --out <tmp>` (installed CLI) and asserts the 11 RPC methods the runtime uses still exist and required param names are unchanged (`initialize`, `account/read`, `config/read`, `thread/start`, `thread/resume`, `thread/name/set`, `thread/list`, `review/start`, `turn/start`, `turn/interrupt`, `externalAgentConfig/import`);
   - a live handshake/smoke test (`initialize` + `thread/start` + `turn/start` with a tiny fake model? at minimum initialize+read methods) gated on a writable `CODEX_HOME` in CI;
   - a broker concurrency test (two simultaneous `review` invocations → expect the second to either queue or fall back to direct, never corrupt state);
   - a model-validation test using `model/list` for `spark` alias.

### 8.4 Reproducing the §1.6 samples

The sample generator lives at `/tmp/codex-samples/gen.mjs` (scratch, not part of the repo). It imports `tests/fake-codex-fixture.mjs`, creates a `/tmp` git repo + fake `codex` on PATH, runs the full command matrix, and writes `/tmp/codex-samples/samples.txt`. Re-running it is the fastest way to see exact stdout/stderr/exit-code behavior for any port change. It writes nothing into the DSH workspace.

---

## 9. Risks and open questions

### 9.1 Codex 0.163.0 wire compatibility — verified, with caveats

Verified 2026-10-19 by generating the installed CLI's schema (`codex app-server generate-json-schema --out /tmp/codex-proto-…`, 318 schema files) and diffing against every call site:

- **All methods exist**: `initialize`, `account/read`, `config/read`, `thread/start`, `thread/resume`, `thread/name/set`, `thread/list`, `review/start`, `turn/start`, `turn/interrupt`, `externalAgentConfig/import` (105 client methods total).
- **Params compatible**: `thread/start` still accepts `{cwd, model, approvalPolicy, sandbox, serviceName, ephemeral}`; `thread/resume` accepts `{threadId, cwd, model, approvalPolicy, sandbox}` (plugin additionally sends `ephemeral:false` from `runAppServerTurn:1106-1110` but `buildResumeParams` drops it — harmless); `review/start` accepts `{threadId, delivery, target}` with `delivery:"inline"` default; `turn/start` accepts `{threadId, input[], model, effort, outputSchema}`; `turn/interrupt` `{threadId, turnId}`; `thread/list` accepts `{cwd, limit, sortKey:"updated_at", sourceKinds:["appServer"], searchTerm}`; `externalAgentConfig/import` requires only `migrationItems` (plugin supplies exactly that).
- **Notifications compatible (superset)**: `thread/started`, `thread/name/updated`, `turn/started`, `item/started`, `item/completed`, `turn/completed`, `error`, `externalAgentConfig/import/completed` all still raised; new required fields (`completedAtMs`/`startedAtMs` on item notifications, `importId`/`itemTypeResults` on import-completed) are ignored by the plugin. `ThreadItem` still has `enteredReviewMode`, `exitedReviewMode`, `agentMessage`, `reasoning` (phase enum `commentary|partial_answer|final_answer`), `commandExecution`, `fileChange`, `collabAgentToolCall`, `webSearch`. `TurnStatus` `completed|interrupted|failed|inProgress`.
- **Caveats:** (a) `review/start` `delivery:"detached"` is now marked **deprecated**; the plugin uses `inline` so fine, but any port that relies on detached review needs the new "thread/start + inline review" pattern; (b) `turn/start.effort` is now typed as a non-empty string rather than an enum, so the plugin's client-side `none|minimal|low|medium|high|xhigh` validation is the only guard — verify model-specific effort names with `model/list` if the CLI rejects one; (c) `getCodexAvailability` only probes `codex --version` and `codex app-server --help`; it does not detect feature drift. Add a version/schema guard.
- **New in 0.163.0 and unused by the plugin:** server `daemon` management, native `--listen unix://`/`ws://` transports, `proxy`, `thread/steer`, `thread/fork`, `model/list`, `plugin/*` management APIs, `skills/list`, `turn/steer`, approval routing (`approvalsReviewer`). The port can opt into `model/list` (validate `spark`) and possibly native transports (§9.3).

### 9.2 `CODEX_HOME` must be writable — verified failure

A live `initialize` handshake against the installed 0.163.0 in this analysis sandbox failed with:

```
Error: failed to initialize sqlite state runtime under ~/.codex:
failed to initialize state runtime at ~/.codex
```

Because the harness sandbox blocks writes outside the workspace, real app-server verification could not run here (tests use the fake CLI, §8.1). For the DSH plugin this means: app-server 0.163.0 initializes a SQLite state runtime under `$CODEX_HOME` (default `~/.codex`) at startup and needs write access to it, plus the Codex CLI binary/auth state. DSH's subprocess environment must grant that (or set a writable `CODEX_HOME`). This is a behavior change vs older CLIs and should be called out in setup diagnostics (`setup` should detect and explain it, not just report "codex not available").

### 9.3 Custom broker vs native app-server daemon

0.163.0 ships `codex app-server --listen unix://…`, `codex app-server daemon start|stop|restart|version`, and `codex app-server proxy --sock …`. The plugin's custom broker exists for the same purpose (shared long-lived app-server, serialized notifications). Risk/benefit:
- Keeping the vendored broker preserves tested behavior (busy code, interrupt passthrough, notification ownership, stale cleanup) and needs only minor patches.
- Replacing it could delete ~450 lines (`app-server-broker.mjs` + `broker-lifecycle.mjs` + endpoint codec) and gain native daemon supervision, but requires verifying **multi-client semantics** (whether one native app-server safely serves concurrent clients/streams, which is precisely what the custom broker serializes) and daemon lifecycle/cleanup. Unverified in this analysis (hung on the §9.2 write restriction). **Recommendation: keep the custom broker for v1; evaluate native daemon as a follow-up spike with a writable environment.**

### 9.4 Concurrency and state races (highest implementation risk)

- `state.json` has **no locking**; every CLI command is a separate process doing load→mutate→write. Concurrent commands (or DSH tool calls) can lose job records, resurrect pruned jobs, or interleave `state.json` writes. DSH commonly runs tools concurrently; in-process port must serialize state mutation (single async mutex) or move state into DSH storage/session log.
- The broker serializes execution but `withAppServer`'s automatic **direct fallback on -32001** silently bypasses serialization: two concurrent Codex runs can each spawn a private app-server. That's functionally OK but resource-heavy and makes cancel/interrupt inconsistent (a private app-server's turn cannot be interrupted through the shared broker path).
- Background worker start race: queued record written after spawning the worker (§5.3); harden by writing before spawn.
- `runTrackedJob` and cancel both write the job file; last writer wins (cancel after worker completes can resurrect a `cancelled` status; worker after cancel can overwrite). Consider a generation/`cancelledAt` guard.

### 9.5 Session identity / data-dir / cwd semantics

- Session scoping is entirely `CODEX_COMPANION_SESSION_ID`-driven. In DSH this becomes explicit `agent.id`; all default-resolution paths (`status`, `result`, `cancel`, `task-resume-candidate`, `--resume-last`) must receive it, otherwise they silently widen to "all sessions"/Codex-thread fallback. `job-control.mjs:15-25` treats missing id as "see everything" — dangerous default for multi-session DSH.
- DSH sessions can change the working directory mid-session (`workingDirectory.set`). The source keys state/broker/jobs by the **git root of the call-time cwd**. Decide: key by session (better for DSH multi-workspace UX) or key by repo (source behavior, needed for `--resume-last` across sessions). Recommend key by repo for Codex thread continuity + store the owning session id separately.
- `CLAUDE_PLUGIN_DATA` replacement: if the port falls back to `os.tmpdir()/codex-companion`, job results/logs and `broker.json` evaporate on reboot and are shared across users on a multi-user box. Use a real DSH profile data directory.

### 9.6 Hooks, review gate, transfer scope decisions

- SessionStart/End map to `agent/created`/`agent/disposed` (verified events) but with different payloads than Claude's hook stdin; the source's env-export mechanism has no DSH equivalent, so the port must inject session/cwd/data-dir through function parameters.
- The stop-time review gate cannot block a DSH stop via `agent/turn-stopping` (serial, `Promise<void>`, no decision). Keeping the gate needs a new design (`agent/pre-step` message replacement, mods-bridge `turn.complete`, or a user-visible "fix review findings" message). Recommend dropping in v1 to avoid a Claude-shaped feature that doesn't map cleanly; the source itself warns it can create a long Claude/Codex loop and drain usage.
- `transfer` is inherently Claude-specific (`~/.claude/projects` + Codex's Claude importer). Drop in v1; document why.

### 9.7 Tool-layer contract details that will bite

- **Flag/arg leakage:** `normalizeArgv` re-splits a single raw string; natural-language prompts containing `--write`, `--model`, `--background`, `--resume` can be reinterpreted as flags. The DSH tool layer must pass explicit argv/in-process and strip routing tokens.
- **`--wait`/`--background` asymmetry:** review/adversarial accept both but only Claude's `Bash(run_in_background)` actually detaches; `task` accepts only `--background` (a `--wait` token becomes prompt text). The rescue command layer strips both before forwarding. In DSH, backgrounding must be decided by the tool implementation (e.g., `ctx.jobs`), not passed through as inert flags.
- **Machine-readable results:** always call with `--json` from the tool layer (or use exports); human mode interleaves prose and embeds `/codex:*` hints that are wrong for DSH.
- **Exit-code semantics:** `setup` returns 0 when not ready; `status --wait` returns 0 on timeout; task/review return 1 when Codex's turn failed but still store a rendered payload. The tool layer must inspect payload fields, not only exit status.
- **stderr surfacing:** in broker mode `codex.stderr` is empty (broker doesn't plumb app-server stderr to clients); failures arrive as JSON-RPC errors and broker logs. Diagnostics for users should point at the log file, and the DSH port should plumb `broker.log` content into error results.
- **Model naming drift:** `spark → gpt-5.3-codex-spark` is a baked alias; `gpt-5.4`/`gpt-5.4-mini` appear in docs/agent prose. These are stale/speculative against 0.163.0's model catalog. Fetch `model/list` in setup and only advertise aliases that exist; keep the alias table in one constant.
- **Output rendering:** native review output is Codex-markdown; adversarial output is a fixed structure with client-side validation. The DSH tool output should preserve severity ordering, file:line formatting, and raw-output fallback (port `render.mjs` strings only).
- **Write safety:** CLI default sandbox is `read-only`; the rescue agent layer adds `--write` by default, and `approvalPolicy:"never"` is hard-coded. Confirm the DSH product intent — a Codex run that writes files without approvals is a real permission decision; DSH's sandbox/approval services may want to mediate (`ctx.approval`, `ctx.sandboxPolicy` exist as Host services).
- **Concurrency of background jobs:** the source has no job-count limit or queue; `task --background` always spawns. DSH should cap concurrent Codex jobs and surface them through `ctx.jobs`/status.

### 9.8 Licensing / provenance

Vendoring is Apache-2.0 with NOTICE obligations (`LICENSE`, `NOTICE` in both repo root and `plugins/codex/`). Keep both files and add a provenance note (upstream repo/commit `db52e28`, version 1.0.6, modifications list) in the DSH bundle. `gpt-5-4-prompting` reference text is first-party OpenAI content under the same license.

### 9.9 Questions the Lead must decide

1. **Vendored CLI + subprocess shim vs in-process TS port.** Vendor is low-risk and testable now (91 tests + fake fixture); in-process is cleaner for DSH (direct `ctx.tools`/`ctx.jobs` integration, no Node CLI/env shims) but is a rewrite of the companion layer and needs new tests. A hybrid is reasonable: vendor `lib/*` logic, replace `codex-companion.mjs` with a TS façade that imports the vendored modules.
2. **Surface:** one multiplexed `codex` tool (action enum) vs several tools (`codex_review`, `codex_adversarial_review`, `codex_task`, `codex_status`, `codex_result`, `codex_cancel`, `codex_setup`) plus DSH commands for the deterministic ones. Commands are needed anyway for `/`-style UX (`ctx.commands`).
3. **Review gate:** drop (recommended) or design a DSH-native gate.
4. **Rescue subagent:** direct tool (recommended) vs a DSH subagent/preset with its own context; if tool-only, move the "write by default + thin forwarder + verbatim stdout" rules into the tool description.
5. **Background execution:** plugin-owned detached Node worker (source) vs `ctx.jobs` integration. `ctx.jobs` gives DSH-native status/read/kill and owner fencing, but its `JobKind` currently exposes only `bash` and records are process-lifetime, not durable across restarts; the source state store is durable and richer (`threadId`, `rendered`, `result`). Consider `ctx.jobs` for live progress + the source store for durable results.
6. **Data dir + cwd keying:** profile data dir path and repo-vs-session keying (§9.5).
7. **Codex binary/env contract:** how DSH grants app-server write access to `CODEX_HOME`; configurable binary path; version floor/ceiling policy (e.g., require ≥0.163.0 and run the schema probe test).
8. **Transfer:** confirm drop.
9. **Model aliases/defaults:** whether to expose `spark`/`gpt-5.x` aliases at all or require explicit model ids from `model/list`.

---

## Appendix A — verification commands

```bash
# source version / provenance
cd ~/Developer/codex-deepseek-plugin/codex-plugin-cc
git log --oneline -8                     # db52e28 …; plugin version 1.0.6
cat plugins/codex/.claude-plugin/plugin.json

# full test suite (no install needed)
npm test                                 # node --test tests/*.test.mjs → 91 pass / 0 fail / ~81.9s

# installed Codex version + protocol surface
codex --version                          # codex-cli 0.163.0
codex app-server --help
codex app-server daemon --help
codex app-server generate-json-schema --out /tmp/codex-proto-XXXX   # 318 schema files
# compare ClientRequest methods / ThreadStartParams / ReviewStartParams / TurnStartParams / notifications

# representative CLI samples (fake app-server, scratch /tmp repo)
node /tmp/codex-samples/gen.mjs          # writes /tmp/codex-samples/samples.txt
```

## Appendix B — line-reference index (most-used patch points)

| Concern | File:line |
|---|---|
| CLI dispatch / usage | `codex-companion.mjs:75-89, 1024-1067` |
| Arg splitting | `codex-companion.mjs:130-149`; `lib/args.mjs:1-128` |
| Session id + filtering | `lib/tracked-jobs.mjs:6,60-68`; `codex-companion.mjs:294-304,336-356`; `lib/job-control.mjs:15-25` |
| Review handlers | `codex-companion.mjs:358-458,712-760` |
| Task handler / worker | `codex-companion.mjs:461-530,671-710,762-823,838-881` |
| Status/result/cancel | `codex-companion.mjs:883-1022`; `lib/job-control.mjs:191-308` |
| State dir / prune | `lib/state.mjs:29-44,80-116` |
| Job lifecycle | `lib/tracked-jobs.mjs:142-203`; `lib/render.mjs:390-446` |
| Broker spawn/reuse/teardown | `lib/broker-lifecycle.mjs:113-209` |
| Broker server | `app-server-broker.mjs:48-247` |
| JSON-RPC client | `lib/app-server.mjs:57-353` |
| Review/turn RPCs | `lib/codex.mjs:1002-1182` |
| Thread params | `lib/codex.mjs:62-88` |
| Auth / setup | `lib/codex.mjs:758-958`; `codex-companion.mjs:182-239` |
| Git target/context | `lib/git.mjs:135-191,225-347` |
| Prompts / schema | `prompts/adversarial-review.md`; `schemas/review-output.schema.json`; `lib/prompts.mjs` |
| Hooks | `hooks/hooks.json:4-36`; `scripts/session-lifecycle-hook.mjs:35-114`; `scripts/stop-review-gate-hook.mjs:98-176` |
| Claude-specific paths | `lib/app-server.mjs:19-30`; `lib/state.mjs:9`; `lib/claude-session-transfer.mjs:7-8`; `scripts/stop-review-gate-hook.mjs:144` |
