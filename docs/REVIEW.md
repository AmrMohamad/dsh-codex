# Deep Code Review — Codex plugin for DeepSeek Harness

Date: 2026-10-19. Reviewers: **OpenAI Codex 0.163** through the plugin's own tools
(`codex_review` native pass + a delegated `codex_rescue` audit), an **independent
internal reviewer agent** ([internal-review.md](internal-review.md)), and a Lead audit.
All findings below were verified against the code; fixes are in the same working tree
and covered by tests where practical.

Result across two review rounds: **0 P0, 10 P1, 26 P2** confirmed issues. All P1s and
the material P2s are fixed and regression-tested. Behavior/format changes are listed in
the last section; the second round (reviewing the fixes themselves) is in
[Round 2](#round-2-reviewing-the-fixes).

## How the review was run (dogfooding the plugin)

1. Copied the bundle to `/tmp/dsh-codex-review`, created an empty git baseline and
   staged the whole plugin so `codex_review` could review it as a normal diff.
2. `codex_review` (background, our plugin) → 8 findings, all reproduced by Codex.
3. `codex_rescue` (background, read-only, our plugin) with a structured audit prompt
   → 17 findings (6 P1, 11 P2), several reproduced with in-memory probes.
4. A fresh independent reviewer agent read the code, ran the tests and reproduced
   findings → 2 P1, 10 P2, 12 P3, plus communication/performance opportunities.
5. Lead reconciled duplicates, verified each claim, fixed, and re-ran unit tests
   (+18 new regression tests, 48 total).

## P1 findings (all fixed)

| # | Finding | Fix |
|---|---|---|
| P1-1 | `codex_rescue` with `resume_last` but no task sent `--prompt-file null`, so the companion tried to open `<cwd>/null` (`ENOENT`). | `taskArgv` only appends `--prompt-file` when a file exists. |
| P1-2 | `/codex-result` and `/codex-cancel` crashed with `TypeError` because `parseCommandInput` was called without its options argument. | Options param defaults to `{}`; regression test exercises the prompt-less-options call. |
| P1-3 | Command flag parsing never honored `--` and parsed flags after task text, so `/codex-rescue -- Explain the --write flag` enabled writes and dropped text. | Parser stops flag parsing at the first positional or `--`; unknown options now error with usage instead of being ignored. |
| P1-4 | Aborting a run that used the no-jobs fallback killed only the companion child; the detached broker kept the Codex turn (and edits) alive. | Direct fallback keeps the job id and asks the companion to cancel/interrupt on abort. |
| P1-5 | Two cold-start runs in one workspace could both spawn detached brokers and overwrite `broker.json`; a later cancel could interrupt the wrong broker. | Broker check/create/publish is serialized with a cross-process lock and `broker.json` is written atomically. |
| P1-6 | App-server/broker death mid-turn left turn collection pending forever (foreground tool or background job stuck). | Turn capture races notification completion with a transport-exit rejection; broker exits if its app-server child dies. |
| P1-7 | Broker lifecycle had no shutdown path (`sendBrokerShutdown` had no callers after the Claude hook was dropped): brokers and their `codex app-server` children leaked forever. | Broker reaps itself after an idle timeout (default 10 min, `CODEX_COMPANION_BROKER_IDLE_MS`) and on app-server exit. |
| P1-8 | Background start failure leaked the prompt/focus temp directory (cleanup only ran for foreground). | Cleanup runs on startup failure and is only handed over after successful job registration. |

## P2 findings (fixed)

- **Cancellation accuracy**: unknown ids were reported as cancelled; two live jobs in
  the workspace were cancelled by guessing the first. Now: unknown id → error; ambiguous
  workspace → ask for `job_id`; explicit id resolves the job's own workspace; no duplicate
  companion cancel process when the Harness job cancel hook already handled it.
- **Retention evicted live jobs**: pruning kept the 50 newest records regardless of
  status and deleted evicted job files. Active jobs are now always retained.
- **Result/status fallbacks**: any companion failure used stored records without checking
  terminal state (a running job's summary could be returned as a "result"), and
  failed/cancelled records lost `errorMessage`; object `result` rendered as
  `[object Object]`. Fallbacks now require terminal status, render status/error/thread,
  and stringify object payloads (bounded).
- **Workspace vs session continuity**: job records are stamped with the DSH session id,
  so a new session in the same workspace saw "No jobs recorded yet" and `resume_last`
  failed. Status, latest result and resume selection are now workspace-scoped (session
  first, then workspace fallback). Actions (`cancel` without id) stay session-scoped.
- **Relative/tilde paths**: relative `cwd` resolved against the Host process cwd and
  `~` was not expanded anywhere. Relative paths now resolve against the session
  directory; `~` is expanded in all configured paths and env overrides.
- **Documented env overrides were dead**: `CODEX_PLUGIN_CODEX_PATH` and
  `CODEX_PLUGIN_DATA_DIR` were documented but unread. Precedence is now
  `plugin config > documented env > legacy env/discovery`.
- **Resolved Codex executable was not executed**: the adapter validated an absolute CLI
  path but the runtime still spawned `codex` by name (broken for wrappers/versioned
  names). The resolved path is pinned through `CODEX_COMPANION_CODEX_BIN` for
  availability probes and `app-server` startup.
- **Data directory split**: the default data dir changed with `DSH_PROFILE`, so the
  Desktop Host and the `dsh` CLI could not see each other's job records. It is now
  profile-independent (`$DSH_HOME/codex-plugin-data`).
- **Progress persistence spawned git repeatedly**: every progress update re-resolved the
  workspace root (synchronous `git rev-parse`, ~11 per update). Workspace roots are
  cached per process.
- **Unbounded Host memory**: `runCompanion` accumulated complete stdout/stderr for jobs
  that already stream into the bounded job ring. Jobs stream without duplicate
  accumulation; direct captures are capped (2 MiB tail) and report truncation.
- **Windows cancellation killed only the immediate child**: the vendored `taskkill /T /F`
  helper is now used on Windows.
- **False "not logged in" on busy/stale broker**: auth probing retried directly when the
  shared broker was busy or its socket was stale.
- **Broker health**: `broker.json` writes are atomic; a dead app-server terminates the
  broker instead of leaving a silent endpoint.
- **Setup latency/cost**: repeated readiness checks ran a full app-server auth handshake
  each time. Positive results are cached for 30 s (`force: true` bypasses it).
- **Slow first resolution**: executable probes had 15–20 s timeouts; reduced to 4–6 s.
- **Stale Claude guidance**: setup still said `!codex login`; now `codex login`.

## Communication improvements (accuracy + speed)

- **Continuity metadata**: every successful foreground Codex result now ends with
  `Codex session: <thread id>`, `codex resume <id>`, and `Codex job: <id>` — so the model
  can continue the same Codex thread (`resume_last`) or report a resumable id.
- **Background start** now points at `codex_result <id>` for the durable result/thread id
  and `job_kill <id>` for cancellation.
- **Durable result fast path**: `codex_result`/`codex_status <id>` for a terminal record
  is served directly from state (no Node process, no app-server); `codex_setup` repeats
  are cached. Measured effect: status/result by id drops from ~120–400 ms (child spawn)
  to a few ms; repeated setup drops from seconds to instant.
- **Workspace-aware status**: an empty workspace status now lists this session's durable
  jobs from other workspaces instead of claiming there are none.
- **Task results** now include touched files and an explicit write-mode warning.
- **Tool descriptions** state the real contracts: `codex_status` is not "durable final
  output" without an id; `wait` has a timeout; `write:true` edits files without a Harness
  approval prompt; rescue results carry the thread id; review results must not be
  auto-fixed.
- **Prompt section and skills** gained a "communication contract": options before text,
  explicit `cwd` when different, one self-contained task per run, don't re-ask what the
  repo answers, continue threads instead of restarting, prefer background for larger
  work, and treat `write:true` as a deliberate escalation.

## Verification

- `npm test`: **67/67 pass** (37 new regression tests across the review rounds: parser
  safety, promptless resume, workspace/data-dir resolution, stored-record rendering,
  continuity footer, fast result path, cross-workspace status, setup cache, cancellation
  accuracy/ambiguity, prompt-file cleanup, cancel-hook interrupt, relative cwd, runner
  cache recovery, failure diagnostics, untracked-symlink redaction, server-request
  responses, write-approval outcomes, broker reaping, Windows/POSIX tree kill,
  spawn-failure fallbacks, timeout validation, `=` in flag values, quote-preserving
  command literals, broker turn tracking).
- Live Codex reviews of this plugin were run through the plugin itself; the native
  review found the seeded defects and the delegated audit reproduced them.
- Broker/transport fixes are covered by inspection plus the unit-level fake registry;
  the live post-fix run is recorded in the final delivery report.

## Round 2: reviewing the fixes

After the first round of fixes, Codex reviewed the patched plugin again (same
`codex_review` workflow). It found 2 P1 and 5 P2 issues — including one introduced by a
first-round fix — all fixed:

| # | Finding | Fix |
|---|---|---|
| P1-9 | Untracked symlinks in adversarial-review context were followed with `statSync`/`readFileSync`, so a repo symlink could inline an outside credentials file into the prompt. | `lstatSync`; symlinks are described as `symlink → <target>; target contents not inlined`. Regression test asserts a secret outside the repo never appears in the context. |
| P1-10 | (Introduced by P1-7.) The broker idle reaper only tracked connection-open time, so a review/task longer than the idle window could be killed mid-turn. | Reaper never runs while any client socket is connected and updates activity on socket data. |
| P2-20 | Relative `cwd` still resolved against the Host process cwd. | Relative paths resolve against the session directory (absolute paths unchanged). |
| P2-21 | A failed Codex resolution left a half-initialized runner cache, so installing Codex could not recover without a plugin reload. | Runtime cache is published atomically; failed init retries on the next call. |
| P2-22 | `codex_result`/`codex_status` needed executable discovery even for terminal stored records. | Data-directory access is independent of executable resolution. |
| P2-23 | Failed turns persisted the failure only in `rendered`, which the failure renderer deliberately ignores. | Failed terminal records persist `summary` + bounded `errorMessage`; regression test covers the rendered result. |
| P2-24 | Setup reported Node unavailable in an Electron-only deployment (no `node` on PATH). | Readiness probes the selected runtime (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`) as a fallback. |

Live after fixes: promptless `resume_last` returned `RESUME_FIX_OK` with the resumed
thread id in the continuity footer; `codex_status` listed prior workspace jobs from the
new workspace scope; repeated `codex_setup` returned instantly with a "(readiness cached
Ns ago)" note; a final foreground rescue returned `FINAL_OK` with its thread id.

## Round 3: remaining risks fixed

The residual risks from round 2 were closed with a Codex consultation on the protocol and
approval design (generated 0.163 types inspected; recommendations applied):

1. **Codex server-to-client requests are handled, not rejected as unknown.** A typed
   policy table (`runtime/scripts/lib/server-requests.mjs`) now answers every 0.163
   `ServerRequest` method:
   - `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` →
     `{decision:"decline"}`;
   - `item/permissions/requestApproval` → `{permissions:{},scope:"turn"}` (no extra
     permissions granted);
   - `item/tool/requestUserInput` → `{answers:{}}` (no fabricated user answers);
   - `mcpServer/elicitation/request` → `{action:"decline",content:null,_meta:null}`;
   - `item/tool/call` (dynamic client tool) → `{success:false,contentItems:[…]}`;
   - legacy `applyPatchApproval`/`execCommandApproval` → legacy `ReviewDecision`
     `{denied:{rejection:…}}`;
   - `account/chatgptAuthTokens/refresh` and `attestation/generate` → explicit
     unsupported protocol errors (never fabricated credentials/tokens).
   Unknown methods still return JSON-RPC `-32601`. A refused action lets the turn
   continue with a narrower approach instead of failing as a protocol error.
2. **Write-capable runs are gated by Harness approval.** `codex_rescue({write:true})`
   asks `ctx.approval.request` before starting (session policy applies, fails closed,
   requires an open turn). Slash-command `--write` is treated as explicit human consent.
   Config `writeApproval: "ask" | "allow" | "deny"` (default `ask`) preauthorizes or
   disables write runs. Approval is requested before prompt files or jobs are created,
   so a refusal starts no Codex process. Verified live: with the session policy at
   `never`, a model-initiated write run is refused and never starts.
3. **Broker reaping has an active-turn guard.** A shared `shouldReapBroker` decision
   ignores brokers with an active request/stream, updates activity on socket data, and
   closes leftover idle sockets before reaping; an in-progress long review can no longer
   be killed by the idle sweep. Unit-tested.
4. **Windows process-tree termination is now exercised.** `terminateTreeImpl` is
   dependency-injected for platform/kill helpers; tests cover the Windows `taskkill /T`
   branch, the POSIX process-group branch, and the direct-kill fallback. (Still not run
   on a real Windows host.)
5. **Remaining low-impact findings cleaned up:** `=` inside flag values preserved;
   `timeout_ms` validated instead of silently dropped; Node minor-version ≥18.18 enforced;
   documented env node path fails loudly; resolver probes have a total budget; stored
   status/result fall back even when the CLI cannot be spawned; dead review-gate surfaces
   and unused exports removed; the test suite is hermetic without a Codex install.

### Round 3b: post-implementation review

Codex reviewed the round-3 implementation and found one regression it had caught in a
stale snapshot plus three genuine issues; all fixed:

| # | Finding | Fix |
|---|---|---|
| P1-11 | Stale `getConfig` calls after removing the review gate made `setup` and no-id `status` crash (`getConfig is not defined`). | Removed both stale calls and the returned `config` field; added a regression test for status-snapshot construction. Found live by the plugin's own `codex_setup` before the review returned. |
| P1-12 | Cancelling while `turn/start` was still pending could lose the turn id: the companion had not persisted it, so the cancel path recorded "cancelled" while a write-capable turn kept running in the broker. | The broker now tracks `threadId → turnId` from streaming responses **and** turn notifications, and interrupts every turn owned by a client socket that disconnects (the child abort closes that socket). Unit-tested tracker; the companion's own cancel path remains as a second layer. |
| P1-13 | Cancellation could still be reported "stopping" indefinitely: the producer fired the companion cancel without awaiting it, and a stale `turn/interrupt` that the app-server never answers could wedge the broker's forwarded-request queue (observed live: a cancel child hung for minutes). | The producer now **awaits** the companion cancel before settling the Harness job, and `turn/interrupt` is bounded at both layers (companion `interruptAppServerTurn` 5 s; broker forwarded requests 5 s for interrupt, 60 s otherwise). Live retest: `job_kill` settled as `killed`, the durable record became `cancelled` within ~1 s, and no hung processes remained. |
| P2-25 | Command tasks were re-tokenized with quote stripping, so `status === "failed"` became `status === failed`. | The parser now parses only the leading option prefix and preserves the literal task/focus suffix byte-for-byte (including quotes and inner spacing); `--` still forces literal text. Regression-tested. |
| P2-26 | A busy broker during `account/read`/`config/read` was converted to "not logged in" inside the auth helper, so the direct-client fallback never ran and setup could cache a false negative. | Retryable broker errors (`-32001`, `ENOENT`, `ECONNREFUSED`) are rethrown to the existing direct-fallback path. |

## Residual risks / not fixed

- Refusing server requests is a safe refusal, not a recovery: an action that truly needs
  approval will fail or be skipped. Individual approval bridging into the plugin is
  deliberately deferred (Codex consultation: pre-flight consent is the right boundary;
  a bridge adds races and still would not authorize ordinary in-sandbox writes).
- `writeApproval: "ask"` consent covers the whole run, not each edit; review the diff
  afterwards (the result text says so).
- Auth-token refresh and attestation requests cannot be satisfied by this client; the
  plugin relies on the CLI's own `~/.codex` authentication and keeps
  `requestAttestation:false`.
- Broker reaping is time-based and per-process; a crash that leaves a broker with no
  clients is reaped on the next idle sweep of that process (default 10 min).
- Windows behavior is unit-tested by injection, not executed on Windows in this
  environment.
- A cancelled turn is interrupted, not awaited: the companion/cancel path is bounded
  (5 s) and the durable record is marked cancelled; app-server may take a moment to
  unwind the aborted turn.
