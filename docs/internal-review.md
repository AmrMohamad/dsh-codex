# Internal review — `dsh-codex` (independent code review)

Reviewer: `reviewer` (independent; based only on reading the code and read-only probes).
Scope: `dsh-codex/` — adapter JS first (`index.js`, `lib/*.js`, tests, package/patch/manifest), then
the runtime diff points listed in `dsh-codex/NOTICE`. DSH API contracts were checked against the
live Host inspect providers and the installed DSH 0.2.1-rc.2 packages extracted read-only from
`app.asar` (`dsh-jobs-local`, `dsh-tools`, `dsh-skill`, `@deepseek-ai/cordis`). No Codex model run
was executed.

## Summary

The adapter is careful and the core lifecycle is mostly right: the raw-ToolDefinition path, command
shape, prompt section, skill registration, package/bundle manifest, job API usage and foreground
collect/remove flow all check out against the live contracts. **Verified end-to-end live** (tools,
skills and prompt section are present in this session; the profile links the bundle; job records
exist in the data dir).

Real problems cluster in four places:

1. **One broken advertised path** — `codex_rescue` with `resume_last` and no `task` sends
   `--prompt-file null` and fails with `ENOENT: .../null` (P1-1; reproduced).
2. **Broker lifecycle** — the port dropped the upstream hook that shut the broker down, so
   `sendBrokerShutdown` has no caller; `ensureBrokerSession` is an unsynchronized check-then-spawn
   and `broker.json` writes are not atomic/locked. Live evidence: two orphaned
   broker+`codex app-server` pairs (~140 MB RSS each pair) after the team's concurrent verification
   runs, only one recorded. Reproduced with a fake broker (P1-2).
3. **Durable-record / temp-file edges** — background start failures leak prompt/focus temp files;
   the cross-workspace stored-record renderer drops failure text and can print `[object Object]`;
   `codex_result` on a running job returns a misleading "Status: running"; `codex_cancel` reports
   success for unknown ids (P2 group; all reproduced).
4. **Contract wording vs behavior** — status/result/`resume_last` are **session**-scoped but the
   tool/prompt/README say "workspace"; `cwd` relative paths resolve against the Host process cwd;
   documented env vars are unimplemented and a documented `~` path is not expanded.

| Count | Severity |
| --- | --- |
| 0 | P0 |
| 2 | P1 (confirmed) |
| 10 | P2 (confirmed) |
| 12 | P3 (confirmed, low impact) |

Test state: `npm test` → **30/30 pass**. The suite does not cover any of the confirmed P1/P2 paths
(see *Test gaps*).

---

## Confirmed findings (P0 / P1 / P2)

### P1 — confirmed bugs

| id | file:line | Problem | Evidence | Minimal fix |
| --- | --- | --- | --- | --- |
| P1-1 | `dsh-codex/lib/runtime.js:445-453` (`taskArgv`); `lib/operations.js:151-166` | `codex_rescue { resume_last: true }` with no `task` always passes `--prompt-file null`. Node coerces the array element `null` to the string `"null"`, and the companion tries to read `<cwd>/null` (`runtime/scripts/codex-companion.mjs:614-621`). The advertised "continue the previous thread" path fails with `ENOENT` instead of using `DEFAULT_CONTINUE_PROMPT`. Both foreground and background go through this builder. | Direct repro of the exact argv produced by the plugin: `taskArgv({cwd:`/tmp/x`, promptFile:null, resumeLast:true})` → `["task","--cwd","/tmp/x","--prompt-file",null,"--resume-last",…]`; `node codex-companion.mjs task --cwd <tmp> --prompt-file null --resume-last` → `ENOENT: no such file or directory, open '<tmp>/null'` (exit 1). Node `spawn`/`spawnSync` stringify `null` args (verified). | Only push `--prompt-file <path>` when `options.promptFile` is a non-empty string. Add a test that `resume_last` without `task` produces argv without `--prompt-file` and no `null`. |
| P1-2 | `dsh-codex/runtime/scripts/lib/broker-lifecycle.mjs:43-57` (shutdown), `:76-100` (load/save), `:113-171` (`ensureBrokerSession`); `runtime/scripts/lib/state.mjs:33-76` | Broker lifecycle leaks processes and races. (a) `sendBrokerShutdown()` has **no call sites**; the upstream `session-lifecycle-hook.mjs` that called it (`codex-plugin-cc/plugins/codex/scripts/session-lifecycle-hook.mjs:101`) was dropped in the port and not replaced, so broker + its `codex app-server` child run until killed externally. (b) `ensureBrokerSession` is check-then-spawn with no cross-process lock and `saveBrokerSession` is a plain `writeFileSync`; two concurrent runs in one workspace both spawn a broker and one is orphaned; a torn read of `broker.json` can spawn yet another. The new state lock does not cover `broker.json`. | Live: `~/.dsh/codex-plugin-data/state/dsh-codex-review-76df184995fe249b/broker.json` records pid 26755; `ps` shows **two** broker processes with PPID 1 (pids 26755 cwd `/private/tmp/dsh-codex-review`, 26849 cwd `/tmp/dsh-codex-review`), each with a `codex app-server` child (104 MB and 97 MB RSS), ~11 min after the last run. The two live jobs were created 54 ms apart. Reproduced race without Codex: concurrent `ensureBrokerSession()` with a fake broker script spawned 2 brokers, `broker.json` recorded only 1 (the other orphaned). | Wrap `ensureBrokerSession` in a lock (reuse the state lock or a sibling `.broker-lock`), write `broker.json` atomically, kill a stale/unresponsive recorded pid (currently `killProcess` is `null` at `:120-127`), and add an idle shutdown in `app-server-broker.mjs` (exit after N min with no client sockets) and/or a `ctx.effect` cleanup in the plugin that sends broker shutdown for known workspaces. |

### P2 — confirmed bugs / contract defects

| id | file:line | Problem | Evidence | Minimal fix |
| --- | --- | --- | --- | --- |
| P2-1 | `dsh-codex/lib/operations.js:116-142` (focus), `:144-177` (prompt) | Temp files are written **before** the `try` and, in the background branch, only cleaned by `onSettled`; if `startBackground`/`jobs.start` throws (no jobs service, per-owner job cap = 10, owner has no live agent, node/codex resolution failure) the `finally` is skipped (`if (!args.background) cleanup()`), so the temp dir with the full task/focus text stays in `$TMPDIR`. | Repro: `operations.rescue(exec,{task,background:true})` with `jobs.start` throwing the real capacity error → 1 new `dsh-codex-prompt-*` dir left; same for `adversarialReview` focus (1 dir). | Move `writePromptFile`/cleanup into the same `try/finally` for both branches (call `cleanup()` on any throw), or clean in a `catch` that rethrows. Add a test. |
| P2-2 | `dsh-codex/lib/runtime.js:517-535` | `renderStoredCodexJob` (the cross-workspace `codex_status`/`codex_result` fallback) does not mirror the companion's own renderer (`runtime/scripts/lib/render.mjs:383-439` — unused here): failed/cancelled records carry `errorMessage` (`tracked-jobs.mjs:181-203`, `:924-983` in companion) but it is dropped, and a record with a `result` object but no `rendered` prints `[object Object]`. | Repro against fabricated records in the real layout: failed record `{status:"failed", errorMessage:"model not available"}` → `"fix the flaky test\n\nStatus: failed"` (error text lost); cancelled → `"Status: cancelled"`; `{result:{rawOutput:"RAW"}}` → `"[object Object]\n\nStatus: completed"`. | Port the companion's `renderStoredJobResult` logic (errorMessage, `result.rawOutput`/`result.codex.stdout`, title/summary) or call it from a runtime helper; never `String()` the payload object. Add unit tests for completed/failed/cancelled/result-only. |
| P2-3 | `dsh-codex/lib/operations.js:205-219` | When `codex_result` is called with a job id that is still running, the companion correctly exits 1 with "Job … is still running…", but the plugin's cross-workspace fallback then finds the running stored record and returns `"Status: running"` — hiding the actionable instruction. | Repro with a fabricated running record + fake runner returning exit 1 → `"fix the flaky test\n\nStatus: running"`. | In the fallback, if `stored.status` is `running`/`queued`, return: job is still running → use `job_output`/`codex_status <id>`, and do not swallow the companion stderr. |
| P2-4 | `dsh-codex/lib/operations.js:228-276` | `cancel` returns `"Requested cancellation of Codex job <id>."` whenever a `job_id` was supplied, even if the Harness registry rejected it (unknown/foreign) and the companion cancel also failed (result ignored at `:258-267`). Related fencing gap: companion `cancel <id>`/`result <id>` deliberately search across sessions in the workspace (`job-control.mjs:281-308`, `:256-279`), so an explicit id can read/stop another session's Codex job that the Harness jobs registry would fence; `findStoredCodexJob` likewise reads any workspace record by id (`lib/runtime.js:491-514`). (Ids are 16 random hex chars, so practical exploitability is low.) | Repro: `jobs.get`/`kill` throwing "unknown job", companion returning exit 1 "No active Codex jobs to cancel" → op still returns `"Requested cancellation of Codex job codex-deadbeef."` | Only return success when `jobs.kill` returned `requested`/`already-finished` or the companion cancel exited 0; otherwise surface the real error ("no such job"/"not in this session"). Consider passing a session filter to companion cancel/result, or documenting the by-id escape hatch as intentional. |
| P2-5 | `index.js:36,38,134,151,171,191` (wording) vs `lib/runtime.js:264-267`, `runtime/scripts/codex-companion.mjs:295-301`, `lib/job-control.mjs:19-25,213-216` (behavior); `README.md:130-138` | The tool descriptions, prompt section, skill and README describe these as **workspace**-scoped, but every child run is stamped with `CODEX_COMPANION_SESSION_ID = exec.agent.id` and the companion filters status/result-without-id/`resume_last` by that session id. A new session in the same workspace sees "No jobs recorded yet." and `resume_last` fails even though the workspace has finished task threads. | Live: running `codex-companion status --cwd /private/tmp/dsh-codex-review` with no session env lists the two workspace jobs; with this session's id it prints `# Codex Status … No jobs recorded yet.` `resume_last` resolves threads only from `filterJobsForCurrentClaudeSession` (`codex-companion.mjs:333-353`). | Pick one contract: either scope these to the workspace (drop/relax session filtering for status/result/`resume_last`; state is already workspace-keyed) or state "this session only" in descriptions/prompt/skill/README. Fix `README.md:130-138` either way. |
| P2-6 | `dsh-codex/lib/operations.js:47-50` | A relative `cwd` argument is resolved with `path.resolve(requested)`, i.e. against the **Host process** cwd — not the session working directory — while the parameter text only says "Working directory (defaults to the session working directory)". A model passing `cwd: "packages/app"` silently targets the wrong (often non-repo) directory. | `path.resolve("subdir")` → `process.cwd()/subdir`; Host cwd is not `ctx.workingDirectory.get(session)`. Same applies to `codex_status`/`codex_result`/`codex_setup`. | Resolve relative paths against the session directory (`path.resolve(sessionCwd, requested)`), or reject non-absolute values with a clear error; document that `cwd` must be absolute. |
| P2-7 | `README.md:90-92,162`, `cordis.patch.yml:11-12` vs `lib/runtime.js:112-115,190-199,233-242`; `README.md:87` | Configuration contract is wrong in three ways: (a) `CODEX_PLUGIN_CODEX_PATH` and `CODEX_PLUGIN_DATA_DIR` are documented "environment-variable equivalents" but are **never read** (only `CODEX_PLUGIN_NODE` is; codex uses undocumented `CODEX_BINARY`); (b) the README config example `dataDir: ~/.dsh/codex-plugin-data` is not tilde-expanded (`path.resolve("~/.dsh/…")` → `<host-cwd>/~/.dsh/…`), so copying it creates a literal `~` directory; (c) an explicitly-set-but-invalid `CODEX_PLUGIN_NODE` is silently skipped instead of reported. | `grep -rn "CODEX_PLUGIN_CODEX_PATH\|CODEX_PLUGIN_DATA_DIR"` finds only docs; code reads `CODEX_PLUGIN_NODE` (`runtime.js:113`), `CODEX_BINARY` (`:191`). `node -e "path.resolve('~/.dsh/x')"` → `/…/~/.dsh/x`. | Implement the documented env vars (or delete the claims), document `CODEX_BINARY`, expand a leading `~/` in `dataDir`/paths, and fail loudly on an invalid explicit env override. |
| P2-8 | `dsh-codex/lib/jobs.js:179-186`; `runtime/scripts/lib/codex.mjs:304-321,556-611` | Foreground runs have no deadline: `waitForJob` loops forever, and an inherited upstream bug leaves `rejectCompletion` unused — if the app-server/broker connection dies mid-turn (crash, external kill, engine error), `captureTurn` awaits `state.completion` forever (`client.exitPromise` is never wired in). A foreground `codex_review`/`codex_rescue` then blocks the model turn until the user aborts. Background runs are recoverable via `job_kill`. | `waitForJob` loops on `jobs.wait(...,300000,…)` with no total deadline; `codex.mjs` creates `rejectCompletion` (`:305-321`) but never calls it; `captureTurn` returns `await state.completion` (`:606`). | (a) Wire client exit/disconnect to `rejectCompletion` in `captureTurn` (also fixes a real hang in the vendored runtime); (b) give foreground runs an overall deadline (e.g., generous configurable cap) that kills the job and reports "Codex did not finish within N min; retry with background:true / job_output". |
| P2-9 | `runtime/scripts/lib/render.mjs:314-322` (`renderTaskResult`), `codex-companion.mjs:494-527` (payload has `touchedFiles`, `threadId`), `dsh-codex/lib/jobs.js:247-258`, `lib/operations.js:302-307` | Tool results lose continuity/completeness metadata that the runtime already collected: foreground (and background `job_output`) output is only `renderTaskResult(rawOutput)` — no Codex `threadId`, no "resume in Codex", no `touchedFiles`, even for `write: true`; the background-start message mentions only `job_output`/`job_kill`, not `codex_result <id>` (the durable record that carries thread id + touched files). The `codex-result-handling` skill tells the model to list touched files it "reported", but the text reported to the model never contains them. | Live record `.../jobs/codex-f3150f460abb4d83.json`: `rendered` head is raw output only; payload keys `[status, threadId, rawOutput, touchedFiles, reasoningSummary]`; plugin never passes `--json` (grep: no `--json` in `lib/`), so payload is unavailable to the adapter and `touchedFiles` is only in the stored JSON. | After settle, read `findStoredCodexJob(dataDir, job.id)` and append a short trailer to the tool text: `Codex session ID: <threadId>` + `Resume in Codex: codex resume <id>` (+ touched files for write runs). In the background-start text add `codex_result <jobId>` for the durable full record. |
| P2-10 | `runtime/scripts/codex-companion.mjs:67,315-331,844-869`, `runtime/scripts/lib/render.mjs:370-381`; `dsh-codex/index.js:178-182` | `codex_status { wait: true }` can block a tool call for **240 s** (companion default when `timeout_ms` is omitted) and the `waitTimedOut` result is discarded by `renderJobStatusReport`, so on timeout the model just sees a normal "running" job with no indication the wait expired — inviting a poll loop even though the prompt says to use `job_output`. This duplicates `job_output`'s wait (30 s default, 600 s cap) with worse semantics. | `DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000` (`:67`); `waitForSingleJobSnapshot` returns `waitTimedOut` (`:326-330`) but `handleStatus` renders `snapshot.job` only (`:853-860`). | Remove `wait`/`timeout_ms` from `codex_status` (point the model at `job_output`) or cap the default at ~10–30 s and render "wait timed out after Ns; job still <status>". |

### P3 — confirmed, low impact (compact)

- **P3-1** `runtime/scripts/codex-companion.mjs:192-193`: setup next-steps still emit the upstream
  Claude-Code shell escape `!codex login` / `!codex login --device-auth`. DSH documents no `!`
  shortcut (composer slash commands are `/…`; shell work is the bash tool); the port patched most
  hints but not this one. Replace with "run `codex login` in a terminal" (or bash tool call).
- **P3-2** `index.js:171-172`: `codex_status` description claims "including the durable final output
  record" — it returns status/progress only; durable output is `codex_result`. `index.js:350,378`
  add "for this workspace"/"active Codex job in this workspace", but both are session-scoped
  (see P2-5).
- **P3-3** `index.js:250-274`: command flags split with `token.slice(2).split("=", 2)` truncates
  values containing `=` (`--base=origin/a=b` → `origin/a`); unknown/mistyped `--flags` become
  positionals, so `/codex-rescue --writ fix bug` silently makes `--writ` part of the task text
  (`index.js:331-346`). Parse with `indexOf("=")` and reject unknown `--flags` with the accepted list.
- **P3-4** `index.js:179-182,353-362` + `lib/operations.js:186-192` + `lib/runtime.js:459-466`:
  `timeout_ms: 0` or a non-numeric string (`Number("abc")` → `NaN`) is falsy, so the argument is
  silently dropped and the 240 s default is used. Validate and error on bad values.
- **P3-5** `lib/jobs.js:264-284`: the no-jobs-service fallback `runCodexDirect` ignores
  `result.aborted`, reporting "Codex companion exited with code unknown." after a user abort; it
  also buffers unbounded output and does not distinguish cancellation.
- **P3-6** `runtime/scripts/lib/codex.mjs:930-963` + `app-server.mjs:331-352`: `codex_setup` only
  *reuses* an existing broker (`reuseExistingBroker: true`) and never repairs a stale/dead
  `broker.json`; it then reports an auth/connect error even though the CLI is fine. During an
  active stream, `account/read`/`config/read` hit the broker's BUSY error
  (`app-server-broker.mjs:167-185`) and setup falsely reports "needs attention".
- **P3-7** `lib/jobs.js:118-131` + `lib/operations.js:258-267`: `/codex-cancel` spawns the cancel
  companion **twice** (fire-and-forget in the job hook, then awaited in the operation), racing two
  state writes. Drop one of the two (the job hook already runs cancel; the awaited one is only
  needed for non-Harness companion ids).
- **P3-8** `lib/runtime.js:316-347`: `runCompanion` accumulates full `stdout`/`stderr` strings for
  the lifetime of every run in the **Host** process, in addition to the bounded job ring. Cap the
  retained buffers to a tail (e.g. 64–256 KiB); in the normal Harness-jobs path only a 4 KB tail is
  used for failure details (`lib/jobs.js:61-68,150-153`).
- **P3-9** `lib/runtime.js:32,67-87,100-163,173-224,543-554`: `resolveNode`/`resolveCodex` use
  synchronous `spawnSync` probes (15 s/20 s timeouts per candidate) from the Host process; a
  hanging/pathological `codex --version` freezes the whole Host on the first Codex tool call.
  `MIN_NODE_MAJOR = 18` but the error text promises >=18.18; a broken explicit
  `CODEX_PLUGIN_NODE` is silently skipped. Resolve asynchronously (or pre-warm off the hot path),
  fix the message/check, and throw on explicitly configured invalid paths.
- **P3-10** `lib/operations.js:205-219` (and `:179-203`): the durable-record fallback is only
  reachable **after** `runner.run()` succeeds, i.e. it still needs Node+Codex resolution. If the
  Codex CLI disappeared (uninstalled, wrong `codexPath`), `codex_result <id>` fails with
  "Codex CLI was not found" instead of reading the durable record the fallback exists for. Run the
  stored-record lookup first when the companion cannot be spawned.
- **P3-11** Dead/unused surfaces: `parseJsonOutput` (`lib/runtime.js:379-397`) is used only by
  tests; `SKILL_FILES.whenToUse` (`index.js:400-403`) is never consumed; the NOTICE's "`jobId` added
  to foreground JSON payloads" patch is unreachable because the adapter never passes `--json`; the
  companion still advertises `setup --enable-review-gate` (`codex-companion.mjs:77,212-236`) though
  the review gate was dropped; `job-control.mjs:300` tells the user "Pass a job id to
  codex_cancel" but there is no `codex_cancel` tool (only the `/codex-cancel` command). Remove or
  wire these up.
- **P3-12** `test/runtime.test.mjs:171-179`: `createRunner resolves lazily` (and `:121-125`,
  `:131-139`) require a real `node`/`codex` installation, so `npm test` is not hermetic despite the
  README claim; it fails on a machine without the Codex CLI.

---

## Risks & design concerns (credible, not confirmed defects)

1. **Write-capable Codex runs bypass DSH sandbox/approval by design.** `write: true` maps to Codex
   `workspace-write` with `approvalPolicy: "never"` (`runtime/scripts/lib/codex.mjs:62-83,1100-1130`);
   the plugin consults no DSH approval/sandbox service. The README documents this
   (`README.md:179-188`), but the model-facing text (`index.js:144-148`, prompt section, skills)
   does not — a model can enable writes while the user believes the session is sandboxed/approval-
   gated. Add the caveat to the parameter description and the `codex-delegation` skill; consider
   gating `write: true` on `ctx.get("approval")` when present.
2. **Owner fencing is partially bypassable with an explicit id.** Cross-workspace
   `codex_result`/`status` (`lib/runtime.js:491-514`) and companion `cancel <id>`/`result <id>`
   operate outside the Harness jobs owner fence; explicit 16-hex random ids are the only barrier.
   Fine for a single-user desktop, worth a deliberate note if multiple agents/teammates share a
   workspace.
3. **Concurrent runs and the shared broker.** Only one streaming turn per broker; the runtime
   transparently falls back to a **second `codex app-server`** (`codex.mjs:613-642`). That works
   but multiplies memory/CPU, and for such fallback runs the companion `cancel`/`interrupt` goes to
   the broker app-server that doesn't own the turn (the plugin's SIGTERM of the child tree still
   stops it). Serializing background Codex runs per workspace (or queuing turns on the broker)
   would make behavior and cancellation uniform.
4. **Broker busy during `codex_setup`** yields false auth failures (P3-6); setup should fall back
   to a direct app-server like `withAppServer` does.
5. **State pruning vs. long quiet runs.** `state.mjs:143-147` prunes to the 50 most recently
   `updatedAt` records and deletes their job/log files. A long-running task whose progress updater
   hasn't changed phase/thread/turn for a while can be pruned from state while still running
   (it is re-added on completion). Low probability, but `codex_status` can transiently miss it.
6. **Corrupt `state.json` silently resets to an empty job list** (`state.mjs:121-141`): the next
   write then rewrites state.json without those jobs (job files are orphaned, not deleted). Atomic
   writes make this unlikely; a backup/merge on parse error would be safer.
7. **Lock design.** The state lock is not re-entrant (`state.mjs:33-70`); current call graph is safe,
   but future nested `updateState`/`writeJobFile` calls would deadlock for 20 s. The 20 s timeout
   throws from `runTrackedJob`'s pre-`try` write path (`tracked-jobs.mjs:151-152`), which would
   surface as a companion failure before the job is recorded.
8. **No plugin-unload cleanup.** `apply` registers no `ctx.effect` cleanup (`index.js:444-471`);
   tool/command/prompt/skill registrations are effect-owned and dispose fine, but in-flight
   children/temp files are only cleaned when jobs settle, and the broker is never stopped (P1-2).
   A teardown effect that kills owned foreground work and shuts down the broker would close this.
9. **Detached children outlive the Host if not canceled.** `runCompanion` spawns `detached: true`
   (`lib/runtime.js:321-327`); if the Host quits without disposing the jobs service, in-flight
   companions (and the broker) survive as orphans. Relying on owner/service disposal is fragile for
   an Electron app quit path.
10. **`--job-id` patch is unvalidated** (`codex-companion.mjs:564-574` → `state.mjs:235-263`
    path-joins it). Safe for adapter-supplied Harness ids, but the vendored CLI is user-runnable:
    add `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (or similar) validation in the runtime.
11. **Prompt temp files** are created in a private `mkdtemp` dir but the file itself is mode 0644 and
    the task text may be sensitive; leaked on background-start failure (P2-1).
12. **`resolveCompletion`/`rejectCompletion` disconnect bug** in `captureTurn` (P2-8) is inherited
    from upstream — fixing it in the vendored runtime also benefits the upstream project.

---

## Communication / tool-contract improvements

- **Report the job id + durable record + thread early.** Background start text should include
  `codex_result <jobId>` (full stored output, survives job-record removal) and, once known, the
  Codex thread id/resume command. Foreground results should carry the same trailer (P2-9).
- **Fix `codex_status` semantics:** description (no "final output record"), no 4-minute `wait`
  (or a short, visible timeout), and return progress even for cross-workspace ids (P2-3, P2-10).
- **Make `codex_cancel` trustworthy:** only claim success for a job that was actually found and
  killed; when nothing was killed, say "no matching Codex job in this session/workspace; run
  codex_status to list ids" (P2-4).
- **State scope consistently** (session vs workspace) in tool descriptions, prompt section, skills
  and README; consider making status/resume workspace-scoped since state already is (P2-5).
- **Add the sandbox/approval caveat for `write: true`** to the tool description, prompt section and
  skill (risk 1).
- **Document `cwd` as absolute or resolve it against the session dir** (P2-6).
- **Setup guidance:** replace `!codex login` with DSH-appropriate wording; make the report say
  whether an active Codex run blocked the auth check (P3-1, P3-6).
- **Fix stale runtime hints:** `job-control.mjs:300` "codex_cancel" (no such tool), and the
  `codex_status` report's "Result: codex_result <id>" is only true for settled jobs (it is gated
  correctly, but the model may try it while running — P2-3's message should cover that).
- **Skill additions:** give `codex-delegation` an explicit `whenToUse` (the loader has a dead
  `whenToUse` slot) and a short "background first for anything > tiny diff; use `codex_result` for
  the durable record; `write:true` bypasses DSH approval" note.
- **Parameters:** document `spark`→`gpt-5.3-codex-spark`, `fresh` (new thread), `effort` values, and
  that `resume_last` currently needs either a delta task or is broken (P1-1).

---

## Performance opportunities

- **Read durable state directly for `codex_status`/`codex_result`** instead of spawning
  `node codex-companion.mjs`: measured ~0.12–0.14 s wall per status spawn on this machine
  (node startup baseline 0.09 s), plus full runtime import. The state layout is stable and already
  implemented in `findStoredCodexJob` (`lib/runtime.js:491-514`) — a native renderer would remove a
  process spawn from a frequently-called tool and from every fallback.
- **`codex_setup` is the heaviest read-only operation**: plugin node spawn → `node --version`,
  `npm --version`, `codex --version`, `codex app-server --help` (4 `spawnSync`), then a full
  `codex app-server` child just to read auth/config (`codex.mjs:930-963`), then SIGTERM. Reuse the
  broker when alive, cache the readiness snapshot for a short TTL, and skip the app-server probe on
  the fast path.
- **Remove the duplicate cancel spawn** on `/codex-cancel` (P3-7): two Node processes + two state
  writes for one cancel.
- **Cap `runCompanion` buffers** (P3-8): the Host keeps every byte of progress for the whole run even
  though only a 4 KB tail is ever used.
- **First-call resolution block:** the first Codex tool call does synchronous candidate probes in
  the Host (`lib/runtime.js:67-224`); a lazy but asynchronous pre-warm at plugin activation (or
  moving resolution off the synchronous `jobs.start` producer path) avoids a potential Host freeze
  on a pathological candidate.
- **Concurrency:** serializing background Codex runs per workspace would avoid the broker-busy →
  second-app-server fallback (risk 3) and the broker spawn race (P1-2), at the cost of queueing.
- Good news: the broker reuse itself is the right call — it avoids a per-run `codex app-server`
  startup for sequential runs and the measured companion spawn (~0.12 s) is acceptable.

---

## Test gaps

The 30 tests validate wiring shape well (argv builders, resolution failures, registration contracts,
foreground failure text) but miss every confirmed P1/P2 path:

1. **`resume_last` without task** — no test catches `--prompt-file null` (P1-1).
2. **Job identity invariant** — no test asserts the companion argv contains `--job-id` equal to the
   Harness job id (`test/operations.test.mjs:46` only checks `argv.slice(0,2)`); a regression to
   unrelated ids would pass.
3. **Producer cancel lifecycle** — the fake jobs registry's `kill()` never calls the spec's `cancel`
   hook (`test/fakes.mjs:84-96`), so `startCodexJob`'s abort + companion-cancel path, the
   killed-status mapping, and `onSettled` cleanup-on-kill are untested.
4. **Abort/signal forwarding** — fake `jobs.wait` ignores `signal`/`timeout`/`caller`
   (`test/fakes.mjs:69-76`), so the foreground tool-abort path is untested; no test aborts a
   foreground run.
5. **`runCodexDirect` fallback** (no jobs service, foreground) — untested (only background-without-
   jobs is).
6. **Durable-record fallback** — no tests for `findStoredCodexJob`/`renderStoredCodexJob` (would
   catch P2-2 and verify the state-dir layout) and none for the running-job result fallback (P2-3).
7. **Temp-file cleanup on failure/settle** — no tests (would catch P2-1 and the background
   `onSettled` path).
8. **Command handlers** — only registration shape is tested; no test of `parseCommandInput`
   (`=` truncation, unknown flags, `--flag=false`, missing value), flag→operation forwarding, or
   command result/error mapping.
9. **Fake `ctx.inject` ignores its `deps` argument** (`test/fakes.mjs:191-195`) and the fake `ctx`
   always provides commands/systemPrompt/skills, so a misspelled optional-service name would still
   pass the suite while the real plugin would silently never register those surfaces.
10. **Fake registry semantics diverge from `dsh-jobs-local`** (non-consuming `read`, no
    caller fencing, no settle ordering, no capacity limit, no lossy reads); the tests can't catch
    misuse of the real contract.
11. **Vendored runtime patches are untested.** `codex-plugin-cc/tests/` has 61 runtime tests plus
    state/render/git/process/broker-endpoint suites; none were carried over (and the paths were
    changed). The new state lock/atomic writes, `CODEX_COMPANION_DATA_DIR` fallback, `--job-id`
    override and `--focus-file` are only exercised manually. At minimum port `state.test.mjs`,
    `render.test.mjs`, `process.test.mjs` and the broker-endpoint tests against the vendored
    runtime, plus a concurrent-writer test for `state.json` (which would also have exposed the
    `broker.json` race in P1-2).
12. **Portability:** `test/runtime.test.mjs:171-179` requires an installed `codex`; `npm test` is
    not hermetic on a clean machine/CI (contradicts `README.md:151`).

---

## What looks correct (explicitly checked, to avoid false alarms)

- **Zero bare imports**: `grep` over `index.js`, `lib/`, `test/` and `runtime/` finds only `node:`
  builtins and relative imports; no peerDependencies needed. `node --check` passes on all files.
- **Raw `ToolDefinition` contract**: `{name, description, parameters, output:{schema,render},
  execute}` matches `dsh-tools` validation (`register()` checks output.render + supported JSON
  schema; `assertSupportedJsonSchema`). The `{text}` output schema is inside the accepted subset.
  The 6 `codex_*` tools are live in this session's tool list.
- **Commands**: `{name, description, input:{hint}, handler(invocation)→{kind:'success',text}}`
  matches `CommandDefinition`; names are lowercase/unique (`/codex-review`, …).
- **`ctx.inject(deps, cb)` is a real Cordis API** (`@deepseek-ai/cordis/src/registry.ts:300`:
  `inject(inject, callback) → plugin({inject, apply})`), so registering commands/systemPrompt/skills
  from `apply` is valid; those registrations return effect-owned disposers and dispose with the
  plugin. Hard `inject = ["tools","workingDirectory"]` is fine (both are mounted in this profile).
- **Prompt section**: one section, unique name `codex-plugin`, order 2500 — exactly the gap the DSH
  recon recommends; the text is visible in this session's system prompt. No collision.
- **Skills**: two kebab-case runtime skills register with name/description/content/invocation; they
  appear in this session's skill catalog. Frontmatter is stripped correctly.
- **Package/bundle manifest**: `dsh.bundle.patch`, `exports["."]`, exported locale JSON and
  `<pkg>/icon`, `locale/en.json` meta title+description, icon < 256 KiB, Apache-2.0 LICENSE +
  upstream NOTICE/LICENSE retained. The profile lists `@local/dsh-codex` with a `link:` dependency
  and a symlink in `node_modules/@local`.
- **Jobs API usage matches the exact Service contract** (`dsh-jobs-local`): `start({kind,label,
  owner,toolCall,outputLimitBytes,run})`, custom `kind` allowed, `wait(id, timeoutMs, caller,
  signal)`, `read/kill/remove(id, caller…)`, `kill` reason, first-wins settlement. Signatures and
  argument order are correct.
- **Foreground collection is not lossy at the settled cap**: settlement retains every unconsumed
  byte for the first terminal read and only then trims to `settledRetainBytes`
  (`dsh-jobs-local/lib/index.js:626-643,769-796`); the plugin's `read` happens right after `wait`,
  so reviews are not truncated at 16 KiB. `remove` is only called after a terminal view, which the
  registry requires. Job-record removal suppresses the completion notice (`awaited`).
- **Abort/cancel mechanics**: SIGTERM to the detached process group, 3 s SIGKILL escalation,
  first-wins settle guard; `aborted`/kill reason maps to `status:"killed"`; the companion also gets
  a best-effort `cancel <id>` for the Codex turn. Double-abort is safe.
- **No argv/shell injection for prompts**: task and focus text travel through temp files
  (`--prompt-file`, `--focus-file`); other values are passed as argv arrays with no shell. The git
  wrapper forces `shell:false` even on Windows (`runtime/scripts/lib/git.mjs:12-18`), so a
  model-supplied `base` cannot inject shell syntax.
- **Path/identity handling**: `findStoredCodexJob` validates the id and rejects `..`/separators
  (`lib/runtime.js:480-514`); its `state/<slug>-<hash>/jobs/<id>.json` layout matches
  `state.mjs:92-115,261-264` and the live data dir; the Harness job id format (`codex-<16 hex>`)
  matches the pattern.
- **Sandboxing of reviews**: native review is read-only, adversarial review uses a read-only turn,
  tasks are read-only unless `write:true` (which maps to Codex `workspace-write`), approval policy
  `never`. This matches the read-only claims made for the review tools.
- **Cross-process state patch**: the directory lock + atomic rename for `state.json` and job files
  is sound for the current (non-reentrant) call graph, and it is exactly the right hardening for
  concurrent runs — the gap is that `broker.json` was not brought under it (P1-2).
- **Node/Codex resolution**: lazy (a missing CLI only breaks Codex tools), Electron
  `ELECTRON_RUN_AS_NODE` handling, PATH-prepending for codex/node dirs, profile-aware data dir, and
  env passed to children all look correct; live runs succeeded with the Harness-provided node.
- **Tests**: 30/30 pass; fake ctx/jobs/runner keep the suite free of Codex calls; failures produce
  actionable messages for missing CLI / missing jobs service.

---

## Verification commands run

```bash
# 1. Test suite (30/30 pass)
cd dsh-codex && npm test

# 2. Static checks
cd dsh-codex && node --check index.js && node --check lib/*.js && node --check runtime/scripts/*.mjs
grep -rnE '^import .* from "[^./]' index.js lib/ test/ runtime/scripts/ --include=*.js --include=*.mjs | grep -v 'from "node:'
npm pack --dry-run            # 36 files, 63.6 kB; no test/ in the pack

# 3. Vendored runtime smoke (no Codex model calls; temp data dir)
CODEX_COMPANION_DATA_DIR=<tmp> node runtime/scripts/codex-companion.mjs help          # exit 0
CODEX_COMPANION_DATA_DIR=<tmp> node runtime/scripts/codex-companion.mjs status --cwd <tmp>  # exit 0, state created under temp

# 4. Resume-without-task repro (P1-1)
node codex-companion.mjs task --cwd <tmp> --prompt-file null --resume-last
# → ENOENT: no such file or directory, open '<tmp>/null'
node -e 'import("./lib/runtime.js").then(({taskArgv}) => console.log(taskArgv({cwd:"/tmp/x", promptFile:null, resumeLast:true})))'
# → ["task","--cwd","/tmp/x","--prompt-file",null,"--resume-last",...]

# 5. Adapter probes (/tmp/review-probes.mjs, imports only dsh-codex/lib/*, fake runner/jobs)
#    - background rescue/adversarial start failure → 1 leaked dsh-codex-prompt-* dir each (P2-1)
#    - renderStoredCodexJob(failed record) → "…\nStatus: failed" (errorMessage dropped) (P2-2)
#    - renderStoredCodexJob({result:{rawOutput}}) → "[object Object]…" (P2-2)
#    - codex_result fallback on a running record → "Status: running" (P2-3)
#    - cancel with unknown id → "Requested cancellation of Codex job codex-deadbeef." (P2-4)

# 6. Broker race repro without Codex (/tmp/broker-race-probe.mjs + /tmp/fake-broker.mjs)
#    → two brokers spawned concurrently; broker.json records 1; the other is orphaned (P1-2)

# 7. Live (read-only) state inspection
cat ~/.dsh/profiles/desktop/package.json             # @local/dsh-codex link: + bundle listed
find ~/.dsh/codex-plugin-data -maxdepth 3            # state/<slug>-<hash>/{state.json,jobs,broker.json}
ps -p 26755 -o pid,ppid,etime,rss,command            # broker alive with PPID 1
ps -p 26849,26801,26850 -o pid,ppid,rss,command     # second orphaned broker + both codex app-servers
node codex-companion.mjs status --cwd /private/tmp/dsh-codex-review                 # lists workspace jobs
CODEX_COMPANION_SESSION_ID=<this session> node codex-companion.mjs status --cwd …    # "No jobs recorded yet." (P2-5)

# 8. DSH contract cross-check (read-only, no state changes)
cordis_inspect_query Host Service listService {"service":"jobs"}   # exact registry semantics
cordis_inspect_list                                                # Service/Config/Tool providers
# DSH packages read from app.asar via a read-only extractor into /tmp (dsh-jobs-local, dsh-tools,
# dsh-skill, @deepseek-ai/cordis) to validate settlement/rendering/registration contracts.

# No Codex review/task/model call was executed; only `codex --version`-class probes and the
# Codex-free companion commands above.
```
