# Codex 0.163 app-server probes

Dependency-free Node ESM probes that validate the Codex `app-server` protocol used by
`codex-plugin-cc/plugins/codex` against the installed `codex-cli 0.163.0`.
The analysis and drift table these probes feed are in [`../docs/codex-protocol.md`](../docs/codex-protocol.md).

## Environment requirements

- `codex` on `PATH` (or set `CODEX_BIN=/path/to/codex`), logged in (`codex login status`).
- A **writable `CODEX_HOME`**. `codex app-server` initializes a SQLite state DB there and will exit with
  `failed to initialize sqlite state runtime under …` if it cannot write. Inside the agent file sandbox
  `~/.codex` is read-only, so probes use [`lib-probe-home.mjs`](lib-probe-home.mjs) to create
  `/tmp/codex-probe-home` and copy the user's readable `auth.json` into it (mode 0600). Nothing else is
  copied by default; set `CODEX_PROBE_COPY_CONFIG=1` to also copy `config.toml`.
  In an unsandboxed shell with a writable `CODEX_HOME` no copy is needed.
- `/tmp` scratch directories are created for cwds and review repos; they are never under the user's repos.
- **Delete `/tmp/codex-probe-home` when done** — it contains live ChatGPT tokens copied from `~/.codex`.

Sandbox caveat: Codex's own per-turn sandbox uses `sandbox-exec` on macOS, which cannot run when the
probes themselves execute inside another sandbox. Turn probes only run "reply with OK" prompts (no shell
commands), and the review probe accepts `--sandbox danger-full-access` so the review agent can read the
scratch repo. Protocol shapes are identical either way; a review attempted with `read-only` inside the
agent sandbox completes but reports `Review blocked: repository access failed with sandbox-exec: …`.

## Probes

| Script | Model calls | Purpose | Report |
| --- | --- | --- | --- |
| `probe-appserver.mjs` | 2 | Full stdio handshake + `thread/start` (plugin params), `thread/name/set` on ephemeral/persistent threads, `turn/start` ("Reply with exactly: OK"), notification capture, `turn/interrupt` on a second thread, `thread/resume`, `thread/list`, `getAuthStatus`, `account/read`, `config/read`, `account/rateLimits/read`, and a no-model param-validation matrix (review targets, custom instructions, unknown `outputSchema`, `turn/start.sandboxPolicy`, `modelReasoningEffort`, `developerInstructions`+`config`). | `report-appserver.json` |
| `probe-review.mjs` | 1 | Creates a scratch git repo in `$TMPDIR` with an off-by-one bug + a bad discount function uncommitted, runs the plugin's exact inline `review/start` uncommitted-changes flow, captures `enteredReviewMode`/`exitedReviewMode` items, the duplicated agent message, `turn/completed`, and the detached-delivery deprecation notice. Also validates custom/baseBranch/commit targets and `outputSchema` tolerance without a model call. Options: `--sandbox <mode>` (default `read-only`), `--experimental`, `--report <path>`. | `report-review.json` |
| `probe-threadlist.mjs` | 1 | Thread source semantics (`thread/start` always records `source:"vscode"`; `threadSource` only sets `thread.threadSource`), `thread/name/set` on ephemeral vs persistent threads, `thread/list` filter matrix before/after the persistent thread has a persisted turn, persistent `thread/resume`, inline-vs-detached `review/start` deprecation. | `report-threadlist.json` |
| `probe-output-schema.mjs` | 1 | `turn/start` with `effort:"low"` and an `outputSchema`; verifies the final `agentMessage` (`phase:"final_answer"`) is schema-conforming JSON. | `report-output-schema.json` |
| `probe-import.mjs` | 0 | `externalAgentConfig/import` with the plugin's exact payload (including the now-typed-but-runtime-tolerated missing `details.skills`), plus a corrected payload and an empty import; captures `externalAgentConfig/import/progress|completed`. Runs entirely against the temp `CODEX_HOME` with a synthetic session file. | `report-import.json` |
| `probe-unix-listen.mjs` | 0 | Native shared transport: `codex app-server --listen unix://PATH` speaks WebSocket-over-unix JSON-RPC; two concurrent WS clients initialize and create threads; bare `--listen unix://` creates `$CODEX_HOME/app-server-control/app-server-control.sock`; observes `codex app-server proxy --sock` and `daemon version`. Includes a minimal RFC6455 client (no deps). | `report-unix-listen.json` |
| `probe-plugin-client.mjs` | 1 | Imports the **unmodified** plugin modules (`scripts/lib/codex.mjs`, `app-server.mjs`, `broker-lifecycle.mjs`) and runs them against 0.163: availability, `getCodexAuthStatus` (broker/direct auto-selection), `runAppServerTurn` through the plugin's own node broker (`thread/start` + `thread/name/set` + `turn/start` + notification capture), then `findLatestTaskThread` (shows the `sourceKinds:["appServer"]` drift). Shuts the broker down at the end. | `report-plugin-client.json` |

## Other evidence

- `app-server-types/` — full `codex app-server generate-ts --out …` output for 0.163 (747 files;
  108 `ClientRequest` methods, 87 `ServerNotification` methods, 10 `ServerRequest` methods).
- `cli-help/` — captured `codex --help`, `codex app-server --help`, `app-server daemon/proxy --help`,
  `codex exec --help`, `codex exec resume/review --help`, `codex review --help`, `codex agents/doctor --help`.
- `report-*.json` — raw captured payloads used as evidence in the report.

## Running

```bash
# from the workspace root
codex app-server generate-ts --out probes/app-server-types

node probes/probe-appserver.mjs
node probes/probe-review.mjs            # inside an agent sandbox: --sandbox danger-full-access
node probes/probe-threadlist.mjs
node probes/probe-output-schema.mjs
node probes/probe-import.mjs
node probes/probe-unix-listen.mjs
node probes/probe-plugin-client.mjs

rm -rf /tmp/codex-probe-home             # remove the copied auth.json
```

Every probe accepts `--report <path>` and prints a compact JSON summary; the full captured payloads are
written to its report file. Probes never write outside `probes/`, `$TMPDIR`, `/tmp/codex-probe-home` and
`/tmp/codex-companion` (the plugin's own broker state dir), and never touch a user repository.
