# Research — similar projects, their failure modes, and how dsh-codex handles them

Date: 2026-10-19. Goal: learn from every project that bridges one coding agent into another
(especially Codex into a host agent), list the problems they hit in production, and make sure
dsh-codex does not repeat them.

## 1. The landscape

| Project | Shape | Notes |
| --- | --- | --- |
| [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | Claude Code plugin; companion CLI + per-workspace `codex app-server` broker | The reference design. dsh-codex vendors its runtime. ~285 open issues at research time. |
| [madciapka/gemini-claude-plugin](https://github.com/madciapka/gemini-claude-plugin), [thepushkarp/cc-gemini-plugin](https://github.com/thepushkarp/cc-gemini-plugin) | Same idea with Gemini CLI (`gemini --acp`) | Thinner protocol, so more workflow logic lives in the plugin ([write-up](https://dev.to/abiswas/what-i-learned-building-a-gemini-plugin-for-claude-code-and-how-it-compares-to-codex-plugin-cc-28i8)). |
| [trailofbits/skills `second-opinion`](https://github.com/trailofbits/skills/issues/301) | MCP server wrapping `codex mcp-server` | Broke when Codex removed `codex mcp-server`. |
| Community Codex MCP servers ([cexll/codex-mcp-server](https://glama.ai/mcp/servers/cexll/codex-mcp-server), [review-mcp](https://glama.ai/mcp/servers/@je4550/review-mcp)) | MCP tools over `codex exec` / MCP | Recurring "lost conversation id" problem with `codex-reply`. |
| App-server drivers ([pingdotgg/t3code](https://github.com/pingdotgg/t3code/pull/18721), [raava-solutions/centaur](https://github.com/raava-solutions/centaur/pull/10), [agentdeck](https://github.com/yuanyang7/agentdeck/issues/9)) | Custom JSON-RPC clients for `codex app-server` | Usage-limit handling, reset times, retry loops. |

Design guidance used as the yardstick: Anthropic, [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
(few consolidated tools, meaningful ids, bounded responses, errors that steer the agent), and
OpenAI's [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
and [App Server write-up](https://openai.com/index/unlocking-the-codex-harness/).

## 2. Failure modes found, and what dsh-codex does

Status legend: **Fixed now** = fixed in this change with a regression test · **Handled** =
already handled before this change · **N/A** = the design avoids it · **Mitigated** = reduced,
not eliminated · **Not applied** = deliberately left, with the reason.

### A. Protocol drift and hangs (the most dangerous class: a silent hang looks like "working")

| Problem | Seen in | dsh-codex |
| --- | --- | --- |
| Start response without `turn.id` → every later notification buffered forever → run hangs | [codex-plugin-cc#781](https://github.com/openai/codex-plugin-cc/issues) | **Fixed now.** Buffering is keyed on "start resolved", and the turn id is recovered from `turn/started`. `test/upstream-fixes.test.mjs`. |
| `shorten()` splits a UTF-16 surrogate pair → app-server drops `thread/name/set` without replying → task hangs at "Starting Codex task thread" | codex-plugin-cc#793 | **Fixed now** in both vendored `shorten()`s and the plugin's own (`lib/text.js`). |
| Usage limit arrives as an `error` notification followed by an ordinary `turn/completed`; drivers report success and relaunch in a tight loop | [openai/codex#47728](https://github.com/openai/codex/issues/47728) | **Fixed now.** A turn with a final (non-`willRetry`) error and no output is a failure; the error text is rendered; `turn.error` is captured; and the agent gets a "do not retry now" hint. |
| `codex mcp-server` removed; MCP-based bridges broke at startup | [trailofbits/skills#301](https://github.com/trailofbits/skills/issues/301), [migration notes](https://www.developersdigest.tech/blog/codex-mcp-server-removed) | **N/A.** dsh-codex uses only stable app-server v2 methods; the CLI surface it needs is checked by `codex_setup`. |
| Response shapes change between versions (e.g. `turn/completed` items empty in 0.145) | [codex_sdk changelog](https://hexdocs.pm/codex_sdk/changelog.html), [codori#168](https://github.com/comfuture/codori/issues/168) | **Handled.** Results are built from the item stream, not `turn.items`; probes in `probes/` pin observed 0.163 behavior. |
| Server-initiated requests (approvals, elicitation) left unanswered → client hangs | [app-server guide](https://codex.danielvaughan.com/2026/03/28/codex-app-server-json-rpc-protocol/) | **Handled.** Typed, schema-valid refusals for every server request (`server-requests.mjs`). |
| Transport dies mid-turn → capture waits forever | codex-plugin-cc (P1-6 in `docs/REVIEW.md`) | **Handled.** Turn capture races completion with transport exit. |

### B. Process lifecycle (leaks, wrong kills, auth side-effects)

| Problem | Seen in | dsh-codex |
| --- | --- | --- |
| Broker that misses its readiness window is torn down **without being killed** → detached broker + app-server leak; repeated cold starts stack them | codex-plugin-cc#801, #782 (found in our copy while verifying) | **Fixed now.** The freshly spawned broker's process tree is killed. Regression test proves the process is gone. |
| Several long-lived app-servers on one `~/.codex` burn the single-use ChatGPT refresh token → every client logged out | [codex-plugin-cc#789](https://github.com/openai/codex-plugin-cc/issues/789) | **Mitigated.** Brokers reap themselves after 10 min idle (active-turn safe), creation is locked per workspace, the leak above is closed, and auth failures now carry a "run `codex login`" hint. Root cause (re-reading `auth.json` before refresh) belongs in Codex itself. |
| Brokers for other workspaces never shut down | codex-plugin-cc#791 | **Handled.** Each broker reaps itself on idle, independent of any session hook. |
| SessionEnd hook kills a shared broker and aborts another session's job; hosts that resume per message lose background jobs | codex-plugin-cc#803, #822 | **N/A.** No session hooks; lifecycle is idle-based with an active-turn guard. |
| SessionStart hook appends duplicate env exports every resume | codex-plugin-cc#819, #810, #788 | **N/A.** No hooks; env is built per spawn. |
| Windows SessionEnd runs `taskkill` serially with no time limit | codex-plugin-cc#815 | **N/A** (no hooks). Windows tree-kill is unit-tested by injection, not yet run on Windows. |
| `cancel` of a foreground companion: process-group kill gets ESRCH, no PID fallback | codex-plugin-cc#786 | **Not applied.** dsh-codex always spawns the companion as a detached group leader, so the group kill works. Our cancel path kills the child first and then runs the companion `cancel`, so a PID fallback there would signal a *stale* pid that may already belong to an unrelated process. |

### C. Review-context correctness and size

| Problem | Seen in | dsh-codex |
| --- | --- | --- |
| `git status --short` first column trimmed (` M` became `M`, unstaged looked staged) | codex-plugin-cc#813 | **Fixed now.** Sections trim only the end. |
| Untracked files whose names git quotes (`café.js`) skipped as unreadable | codex-plugin-cc#812 | **Fixed now.** Path lists use `-z`; status uses `core.quotePath=false`. |
| Every untracked file inlined (up to 24 KiB each) with **no total cap**: an unignored build/vendor dir put megabytes into the prompt | found here | **Fixed now.** 64 KiB total budget; remaining files are named with a pointer to read them directly. |
| Untracked symlinks followed into credentials | dsh-codex review P1 | **Handled.** Symlinks are described, never followed. |

### D. Inputs and safety

| Problem | Seen in | dsh-codex |
| --- | --- | --- |
| `--key=value` cut at the second `=` | codex-plugin-cc#807 | **Fixed now** in the vendored `parseArgs`. The plugin never passes inline values (`lib/argv.js`). |
| Rescue delegates write-capable work by default | codex-plugin-cc#798 | **Handled.** Read-only by default; model-initiated writes need Harness approval (fails closed). |
| Auth check says "not authenticated" for Azure / custom-provider / no-auth setups | codex-plugin-cc#58, #233 | **Handled.** Auth comes from `account/read` + `requiresOpenaiAuth`, not `codex login status`. |
| Setup readiness cache served a stale "needs attention" right after `codex login` | found here | **Fixed now.** Only a ready report is cached. |

### E. Agent-facing quality (the model is the user of these tools)

| Problem | Source | dsh-codex |
| --- | --- | --- |
| Opaque errors (`401`, `refresh_token_reused`, "usage limit") → agents retry blindly | Anthropic guide; openai/codex#47728 | **Fixed now.** `lib/diagnose.js` appends one `Hint:` line naming the next step; the prompt section tells the agent to follow it. |
| Failed background jobs said only "exited with code 1" (output capture is off for jobs) | found here | **Fixed now.** Bounded stdout/stderr tails explain the failure in the job status. |
| Lost conversation ids make follow-ups impossible | codex MCP servers | **Handled.** Every result carries the Codex thread id, `codex resume <id>`, and `resume_last`. |
| Hosts truncate the middle of long tool errors | [MCP feature comparison](https://m3.sineframe.com/blog/claude-code-vs-codex-mcp) | **Handled.** The cause comes first and the hint last; tails are bounded. |
| Too many or overlapping tools | Anthropic guide | **Handled.** Six namespaced `codex_*` tools; commands reuse the same operations. |

## 3. Efficiency and maintainability changes

- **Prompt size:** untracked context is capped (above). Status lists are capped at 8.
- **Host responsiveness:** Node resolution is cached even while Codex is missing. Probes use
  blocking `spawnSync` in the Electron Host, and before this change every call re-probed until
  Codex was installed.
- **No redundant processes:** status/result by id read durable records directly. Cancel does
  not spawn a second companion when the job's cancel hook already ran.
- **Structure:** `index.js` (556 lines) and `lib/runtime.js` (824 lines) each mixed five
  concerns. They are now single-purpose modules (`tools`, `commands`, `prompt`, `skills`,
  `resolve`, `process`, `argv`, `job-store`, `diagnose`, `text`), and copy-pasted flows in
  `operations.js` (temp-file lifetime, stored-record fallback) are single helpers. Dead
  code (`resolveWorkspaceRootCached`) was removed. `AGENTS.md` maps the modules and the
  invariants for humans and agents.

## 4. Still open (tracked, not fixed here)

- Real Windows end-to-end run (tree-kill, named pipes).
- Codex-side refresh-token rotation across processes (#789 root cause) — upstream.
- Usage-limit reset time (`account/rateLimits/updated` → `resetsAt`) is not surfaced yet;
  the hint says "after the limit resets" without a time.
- `openai/codex#48042` / `#32432` report false `usage_limit_exceeded` errors; dsh-codex
  reports them faithfully and cannot tell them apart.
