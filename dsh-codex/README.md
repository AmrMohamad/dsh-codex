# Codex for DeepSeek Harness

Use the local **OpenAI Codex CLI** from [DeepSeek Harness](https://deepseek.com) (DSH):
run Codex's native code review, an adversarial design review, or hand a whole
investigation/implementation task to Codex — all as native DSH tools with native
background jobs.

This is a port of OpenAI's
[Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) to the
DeepSeek Harness plugin model. The Claude-only command Markdown, subagent
forwarder, hooks and session-transfer layer were replaced by native DSH
registration (tools, slash commands, prompt section, embedded skills, `ctx.jobs`),
while the proven app-server companion runtime is vendored and adapted
(see [Architecture](#architecture)).

## What you get

| Tool | What it does |
| --- | --- |
| `codex_review` | Codex's native, read-only review of the working tree or a base branch. Never edits code. |
| `codex_adversarial_review` | Read-only, steerable review that challenges the design, tradeoffs, assumptions and failure modes. Takes `focus` text. |
| `codex_rescue` | Hands an investigation/diagnosis/implementation task to Codex in a persistent Codex thread. Read-only unless `write: true`; `resume_last` continues the previous thread. |
| `codex_status` | Active and recent Codex jobs for the workspace, with durable records. |
| `codex_result` | Stored final output of a finished Codex job. |
| `codex_setup` | Codex CLI installation/authentication readiness. |

Human slash commands in the DSH composer: `/codex-review`, `/codex-adversarial-review`,
`/codex-rescue`, `/codex-status`, `/codex-result`, `/codex-cancel`, `/codex-setup`.

Two embedded skills give the agent Codex-specific guidance:
`codex-delegation` (when and how to delegate, prompt contracts) and
`codex-result-handling` (faithful reporting, never auto-apply review fixes).

### Background runs

Pass `background: true` (recommended for anything larger than a tiny diff). The run
becomes a normal DSH background job: `job_output` streams progress and the final
result, `job_kill` cancels it (including interrupting the Codex turn in the shared
app-server broker), and the owning session is notified when it finishes. Codex job
records are durable in the plugin data directory, so `codex_status`/`codex_result`
work across restarts.

## Requirements

- **Codex CLI** installed and logged in (`codex login`). The port is tested against
  `codex-cli 0.163.0`; any version exposing `codex app-server` with the v2
  `thread/*`, `turn/*`, `review/start` methods works.
- **DeepSeek Harness desktop 0.2.1-rc.2** (the version this plugin was developed and
  verified against). No peer dependencies: the plugin imports only Node builtins.
- Node.js is **not** required in `PATH`: the plugin reuses the Harness runtime's
  Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`) or a Harness-provisioned node,
  falling back to `node` in `PATH`.

The plugin uses your existing Codex installation, authentication state
(`~/.codex`), `config.toml` (model, reasoning effort, sandbox, MCP servers) and
working tree, exactly like running Codex yourself.

## Install

Use the DeepSeek Harness Plugin Manager / `plugin_manager` tool with
`action: install_bundle` and the absolute path to this directory:

```
~/Developer/codex-deepseek-plugin/dsh-codex
```

The bundle installs as `@local/dsh-codex`, appends itself to the profile's
`dsh.profile.bundles`, and activates through HMR (a desktop restart is only
required when replacing already-loaded JavaScript). Verify with the approval-free
Host inspector: `Tool/listTools` shows the `codex_*` tools, and
`Config/listConfigs` with `name: "@local/dsh-codex"` shows the plugin row.

First run `codex_setup` (or `/codex-setup`): it reports Node/Codex/auth/broker
readiness and the next step when something is missing.

## Configuration

Zero configuration is the common path. Optional settings can be placed on the
plugin row in your profile patch:

```yaml
- id: codex
  name: '@local/dsh-codex'
  config:
    codexPath: /opt/homebrew/bin/codex   # default: auto-detect PATH + common locations
    nodePath: /path/to/node              # default: Harness Electron runtime / bundled node / PATH
    dataDir: ~/.dsh/codex-plugin-data    # default: $DSH_HOME/codex-plugin-data (see below)
    writeApproval: ask                   # ask (default) | allow | deny
```

Environment-variable equivalents (useful when the DSH Host was launched from
Finder with a minimal `PATH`): `CODEX_PLUGIN_CODEX_PATH`, `CODEX_PLUGIN_NODE`,
`CODEX_PLUGIN_DATA_DIR`. Precedence is plugin config > these documented variables >
legacy variables (`CODEX_BINARY`) > automatic discovery. `~` is expanded in every
path value.

Model and reasoning effort default to your Codex `config.toml`; tools can override
them per run (`model`, `effort`). `spark` is mapped to `gpt-5.3-codex-spark`.

## Architecture

```
DSH Host plugin (index.js, zero imports)
├─ tools/commands/prompt/skills  ── native DSH registration
├─ lib/runtime.js               ── node/codex resolution, child env, argv, process lifecycle
├─ lib/jobs.js                  ── ctx.jobs integration: stream, cancel, collect
├─ lib/operations.js            ── review / adversarial-review / rescue / status / result / cancel / setup
└─ runtime/                     ── vendored codex-companion (Apache-2.0, patched)
   ├─ scripts/codex-companion.mjs
   ├─ scripts/app-server-broker.mjs   ── one shared `codex app-server` per workspace (unix socket)
   └─ scripts/lib/*.mjs               ── JSON-RPC client, git review targets, prompts, state, rendering
```

Run flow: the plugin spawns `node runtime/scripts/codex-companion.mjs …` as a child
process (never through the DSH shell tools, so Codex is not nested inside the
Harness file sandbox). The companion connects to the per-workspace app-server
broker, performs the review/turn and writes durable job state. The child's
stdout/stderr stream into a native DSH background job whose id is also passed to
the companion as `--job-id`, so one identity spans the Harness job, the companion
record and the final result.

Data written by the plugin. The default data directory is
`$DSH_HOME/codex-plugin-data` for both the Desktop Host and the `dsh` CLI, so job
records and Codex thread ids are shared across sessions and surfaces.

- `<dataDir>/state/<workspace-slug>-<hash>/state.json` — Codex job records (max 50)
- `<dataDir>/state/<workspace-slug>-<hash>/jobs/<id>.{json,log}` — per-job payload and progress log
- `<dataDir>/state/<workspace-slug>-<hash>/broker.json` — shared broker endpoint
- the broker's unix socket and log live under the OS temp directory and are reused
  until stale

## Review-hardening notes

The plugin was reviewed by Codex itself (through `codex_review` and a delegated
`codex_rescue` audit) plus an independent internal reviewer; every reported P1 was
reproduced and fixed. Highlights that change behavior:

- Command flags are only recognized before the task/focus text; use `--` to pass
  literal dashes. Unknown options error instead of being ignored.
- A successful foreground result ends with the Codex thread id and resume command.
- `codex_result`/`codex_status <id>` for terminal jobs are served from state without
  spawning a process; `codex_setup` results are cached for 30 s (`force: true` to
  re-check). When the Codex CLI cannot be spawned, status/result still fall back to
  durable records. Model-initiated `write: true` runs require Harness approval.
- Status/result/resume are workspace-scoped, so a new DSH session can continue prior
  Codex work; cancellation without an id stays session-scoped and refuses to guess
  between multiple live jobs.
- The shared broker self-reaps after 10 idle minutes (and exits if its app-server dies),
  so no orphan processes accumulate.

Full details: [`docs/REVIEW.md`](../docs/REVIEW.md).

## Known limitations (v1)

- **No Stop-time review gate.** The Claude plugin's `Stop` hook has no equivalent
  decision point in DSH; run `codex_review` explicitly instead.
- **No session transfer.** Codex's external-agent importer only understands Claude
  JSONL sessions; transferring a DSH session would need a new exporter.
- **`codex_status`/`codex_result` are workspace-scoped.** A job id always resolves
  (there is a cross-workspace fallback reading durable records), but the list view is
  for the current session working directory.
- **Codex server-to-client requests are declined** with JSON-RPC `-32601` by the
  runtime. Normal reviews/tasks use approval policy `never` and explicit sandboxes, so
  no approval requests occur; a future Codex flow requiring elicitation would need a
  handler.
- **No Config schema.** Settings are passed through the plugin row / env vars
  unaffected by validation (see Configuration).
- **Slash-command GUI surface** is registered in the Host command registry but was not
  clicked through in the UI during verification; the same handlers are unit-tested and
  the tools are live.

## Verification

- `npm test` — 67 hermetic tests (fake Harness context, jobs registry and runner; no
  real Codex calls), including 37 regression tests from the review rounds.
- Live on this machine: `codex_setup`, a background `codex_review` that found a seeded
  P1, cross-workspace `codex_result`, a foreground `codex_rescue`, an adversarial
  review with a parsed verdict, background start + `job_kill` (turn interrupted,
  companion record `cancelled`), and `resume_last`. See
  [`PLAN.md`](../PLAN.md#7-verification-evidence-live-this-machine).
- Deep review and hardening (three independent reviewers plus a second Codex review of
  the fixes themselves; 10 P1 / 26 P2 findings fixed):
  [`docs/REVIEW.md`](../docs/REVIEW.md).

## Troubleshooting

- **Codex CLI not found** — the Host may have a minimal `PATH`. Set `codexPath` in
  the plugin row or `CODEX_PLUGIN_CODEX_PATH`.
- **Not logged in** — run `codex login` in a terminal, then `codex_setup`. API-key
  auth works the same way.
- **`failed to initialize sqlite state runtime under ~/.codex`** — Codex needs a
  writable `CODEX_HOME` (default `~/.codex`). Fix permissions or set `CODEX_HOME`.
  This plugin spawns Codex from the Host process, which is not file-sandboxed; a
  Codex run started *from inside a sandboxed shell* can hit this.
- **Nested `sandbox-exec: sandbox_apply: Operation not permitted`** — you ran the
  companion from inside another sandbox (for example the DSH `bash` tool). Let the
  plugin run it from the Host instead.
- **Stale shared runtime** — the broker is reused per workspace. If Codex was
  killed externally, delete `broker.json` in the workspace's state directory (or
  the whole `<dataDir>/state` directory) and retry.
- **Cancel a run** — `job_kill` for a background job, or `/codex-cancel` for the
  active Codex job in the workspace. Both interrupt the Codex turn, not only the
  child process.

## Security notes

- Plugin-spawned processes bypass the DSH file sandbox by design (the Harness only
  sandboxes shell-tool execution). Codex applies its own sandbox and approval
  policy from `config.toml`.
- `codex_review` and `codex_adversarial_review` are read-only. `codex_rescue` is
  read-only unless `write: true` is passed, in which case Codex runs with its
  `workspace-write` sandbox. Model-initiated write runs are gated by the Harness
  approval service (session policy; fails closed). Slash-command `--write` is
  explicit human consent. `writeApproval: deny` disables write runs entirely and
  `allow` preauthorizes them.
- Codex app-server requests that need interactive input are declined with
  schema-valid refusals (approval requests, MCP elicitation, dynamic client tools);
  auth-token refresh and attestation requests get a clear protocol error, so turns
  continue with a narrower approach instead of hitting "method not found".
- Review findings must never be auto-applied: the prompt guidance and the
  `codex-result-handling` skill both require asking the user first.

## Development

```bash
cd dsh-codex
npm test          # 67 hermetic unit tests, no Codex calls
```

Layout: `index.js` (registration), `lib/` (adapter), `runtime/` (vendored
companion), `test/` (fake-ctx and fake-runner tests), `docs/` at the workspace
root contains the source-analysis, DSH-API and Codex-protocol recon.

## Attribution

Apache-2.0. The vendored runtime is derived from
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0);
see `runtime/LICENSE`, `runtime/NOTICE` and the top-level `NOTICE` for the exact
modification list.
