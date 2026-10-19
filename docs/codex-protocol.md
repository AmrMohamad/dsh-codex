# Codex 0.163 app-server protocol — probe report & plugin compatibility

**Verdict: the plugin's JSON-RPC usage is compatible with Codex `0.163.0` after small patches.**
No request the plugin sends has been renamed or removed, and every notification it listens to is still
emitted. The plugin's **unmodified client code was run end-to-end against 0.163** (broker transport, auth,
persistent thread, turn capture) and works. Three real drifts need patches: `thread/list`'s
`sourceKinds: ["appServer"]` filter (always empty now), naming ephemeral threads (now rejected), and the
stale generated-type/type-map layer. `review/start` works and still delivers review text; **custom review
instructions are supported via `ReviewTarget.custom`, but review output schemas are not** (the plugin's
schema-constrained path correctly uses `turn/start.outputSchema`, which 0.163 honors).

- Probe date: 2026-10-19 (Africa/Cairo)
- Codex: `codex-cli 0.163.0` (`/opt/homebrew/bin/codex`)
- Plugin under test: `codex-plugin-cc/plugins/codex` v1.0.6
- Evidence: [`probes/app-server-types/`](../probes/app-server-types/) (generated TS), [`probes/report-*.json`](../probes/) (raw captures)
- Reproduce: see §9 and [`probes/README.md`](../probes/README.md)

---

## 1. Environment

| Fact | Value |
| --- | --- |
| Codex binary | `/opt/homebrew/bin/codex` → `/opt/homebrew/Caskroom/codex/0.163.0/bin/codex` |
| Version | `codex-cli 0.163.0` |
| Host | macOS 27.0.1, arm64 (Mac mini), Node v26.12.0 used for probes |
| Auth | logged in via ChatGPT (`account.type = "chatgpt"`, plan `plus`); `auth_mode = "chatgpt"` |
| Effective default model (fresh probe home) | `gpt-6.1-sol`, provider `openai`, `serviceTier: null` |
| Default approval/sandbox when omitted | `approvalPolicy: "on-request"`, sandbox `readOnly` |
| Probe `CODEX_HOME` | `/tmp/codex-probe-home` (see caveat below), real `CODEX_HOME` = `~/.codex` |
| Rate-limit snapshot | primary 3 % of 300 min, secondary 48 % of 10080 min, 1 reset credit available |

`codex app-server generate-ts --out probes/app-server-types` produced **747 TypeScript files**
(94 root-level files + `serde_json/JsonValue.ts` + 652 files under `v2/`, including both `index.ts`
barrels) containing:

- **108** client→server request methods (`probes/app-server-types/ClientRequest.ts`)
- **87** server→client notification methods (`probes/app-server-types/ServerNotification.ts`)
- **10** server→client request methods (`probes/app-server-types/ServerRequest.ts`)
- **1** client notification (`initialized`, `ClientNotification.ts`)

The plugin's `scripts/lib/app-server-protocol.d.ts` import layout (`.../app-server-types/index.js` for
`InitializeParams` and `.../v2/index.js` for the v2 params) matches the 0.163 generator output.

**Probe-environment caveat.** These probes ran inside the agent's `workspace-write` file sandbox, where
`~/.codex` is read-only and macOS `sandbox-exec`/`ps` are blocked. Codex cannot initialize its SQLite state
DB without a writable `CODEX_HOME`, so the probes use a temporary `CODEX_HOME` containing a copy of the
user's readable `auth.json` (helper: [`probes/lib-probe-home.mjs`](../probes/lib-probe-home.mjs); auth file mode 0600,
never printed). Consequences for this report:

- All protocol shapes, notifications and request/response bodies are unaffected.
- A review run against a scratch repo needed `sandbox: "danger-full-access"` **for the probed review thread**
  because Codex's own `read-only` sandbox calls `sandbox-exec`, which the outer agent sandbox denies. With
  `read-only` the review turn still completed correctly but returned
  `"Review blocked: repository access failed with sandbox-exec: sandbox_apply: Operation not permitted…"`.
  In a normal user shell the plugin's `read-only` review thread works as before.
- `codex app-server daemon start` cannot be validated in this sandbox (`ps` is denied), so the daemon
  section is help-text + socket-protocol evidence only.
- End state: delete the temp home when finished: `rm -rf /tmp/codex-probe-home` (the copy contains live
  ChatGPT tokens).

Model calls used by all probes: 8 short calls (one OK turn + one interrupted turn, one review attempt
blocked by the probe sandbox + one real review on a scratch repo, three trivial OK turns: thread-list,
output-schema and plugin-client probes). Scratch review repos live under `$TMPDIR` only.

---

## 2. Handshake

Transport is unchanged: one JSON object per line over the child's stdio, **no `jsonrpc: "2.0"` field**
(the plugin's dialect works as-is). The client sends `initialize` (request) then `initialized`
(notification, no `id`). `codex app-server` is spawned with **no arguments** (exactly what the plugin does).

Captured from [`probes/report-appserver.json`](../probes/report-appserver.json) (`handshake`):

```jsonc
// -> (id 1)
{"method":"initialize","params":{
  "clientInfo":{"name":"Claude Code","title":"Codex Plugin","version":"0.0.0-probe"},
  "capabilities":{
    "experimentalApi":false,
    "requestAttestation":false,
    "optOutNotificationMethods":[
      "item/agentMessage/delta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/textDelta"
    ]
  }}}
// <- result
{"userAgent":"Claude Code/0.163.0 (Mac OS 27.0.1; arm64) dumb (Claude Code; 0.0.0-probe)",
 "codexHome":"/private/tmp/codex-probe-home","platformFamily":"unix","platformOs":"macos"}
// -> notification
{"method":"initialized","params":{}}
```

Notes:

- `InitializeParams = { clientInfo: ClientInfo, capabilities: InitializeCapabilities | null }`
  (`app-server-types/InitializeParams.ts`); `ClientInfo = { name: string, title: string | null, version: string }`.
- `InitializeCapabilities` (`app-server-types/InitializeCapabilities.ts`) still **requires**
  `experimentalApi: boolean` and `requestAttestation: boolean`; `optOutNotificationMethods` is optional and
  all four names the plugin suppresses are still valid 0.163 notification methods. New optional fields:
  `explicitGatewayOauth`, `mcpServerOpenaiFormElicitation`, `extensions`.
- `InitializeResponse` gained `codexHome`, `platformFamily`, `platformOs`; `userAgent` remains. The plugin
  validates none of them; the **broker fakes only `{userAgent}`** (`app-server-broker.mjs:146-153`) which is
  fine today but should be extended if the plugin starts reading the new fields.
- `thread.originator` in responses is derived from `clientInfo.name` (`"Claude Code"`), so changing
  `ClientInfo.name` changes the recorded originator.
- **`experimentalApi: false` is sufficient for every method the plugin uses** — verified for `thread/start`,
  `turn/start`, `turn/interrupt`, `review/start`, `thread/resume`, `thread/name/set`, `thread/list`,
  `account/read`, `config/read`, `getAuthStatus`, `account/rateLimits/read`,
  `externalAgentConfig/import`. No `experimentalApi: true` requirement was observed.
- The server emits unsolicited notifications immediately after `initialize` (`account/updated`,
  `remoteControl/status/changed`, `mcpServer/startupStatus/updated`); the plugin ignores unknown methods.
- 0.163's notification envelope (`ServerNotificationEnvelope.ts`) adds an optional top-level
  `emittedAtMs` field next to `{method, params}`; the plugin's line handler ignores it.

---

## 3. Method inventory & v2 param shapes

### 3.1 Every method the plugin sends exists in 0.163

| Request | 0.163 params type | Plugin call site | Status |
| --- | --- | --- | --- |
| `initialize` | `InitializeParams` | `app-server.mjs:225-229`, `305-309` | ✅ unchanged |
| `thread/start` | `v2/ThreadStartParams` | `codex.mjs:732-748` | ✅ unchanged |
| `thread/resume` | `v2/ThreadResumeParams` | `codex.mjs:750-752` | ✅ unchanged |
| `thread/name/set` | `v2/ThreadSetNameParams` | `codex.mjs:735-746` | ⚠️ params unchanged, **ephemeral threads reject it** |
| `thread/list` | `v2/ThreadListParams` | `codex.mjs:1168-1175` | ⚠️ `sourceKinds:["appServer"]` never matches |
| `turn/start` | `v2/TurnStartParams` | `codex.mjs:1132-1144` | ✅ unchanged |
| `turn/interrupt` | `v2/TurnInterruptParams` | `codex.mjs:983` | ✅ unchanged |
| `review/start` | `v2/ReviewStartParams` | `codex.mjs:1022-1031` | ✅ unchanged; custom target supported, no `outputSchema` field |
| `account/read` | `v2/GetAccountParams` | `codex.mjs:870` | ✅ unchanged |
| `config/read` | `v2/ConfigReadParams` | `codex.mjs:871-874` | ✅ unchanged |
| `externalAgentConfig/import` | `v2/ExternalAgentConfigImportParams` | `codex.mjs:724`, `681-699` | ✅ accepted; declared `details.skills` now required in type (runtime tolerant) |
| `getAuthStatus` (legacy; not called anymore) | `GetAuthStatusParams` | old versions only | ✅ still present |

`app-server-protocol.d.ts` only maps 9 methods (`initialize`, `externalAgentConfig/import`, `thread/start`,
`thread/resume`, `thread/name/set`, `thread/list`, `review/start`, `turn/start`, `turn/interrupt`) —
`account/read` and `config/read` are called from untyped `.mjs` and are missing from the map. Add them (and
regenerate the `.generated` tree with 0.163 `generate-ts`).

### 3.2 Request/param shapes (exact 0.163 declarations)

`v2/ThreadStartParams.ts`:

```ts
export type ThreadStartParams = {
  model?: string | null, modelProvider?: string | null,
  serviceTier?: string | null | null, cwd?: string | null,
  approvalPolicy?: AskForApproval | null,
  approvalsReviewer?: ApprovalsReviewer | null,
  sandbox?: SandboxMode | null,
  config?: { [key in string]?: JsonValue } | null,
  serviceName?: string | null,
  baseInstructions?: string | null,
  developerInstructions?: string | null,
  personality?: Personality | null,           // deprecated
  ephemeral?: boolean | null,
  sessionStartSource?: ThreadStartSource | null,
  threadSource?: ThreadSource | null          // analytics classification string
};
```

`v2/ThreadResumeParams.ts`: `threadId` (required) plus the same override fields (`model`, `modelProvider`,
`serviceTier`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `config`, `baseInstructions`,
`developerInstructions`, `personality` deprecated, `excludeTurns?`) — no `ephemeral` field.

`v2/TurnStartParams.ts` (fields the plugin uses and nearby fields):

```ts
export type TurnStartParams = {
  threadId: string, input: Array<UserInput>,
  // … clientUserMessageId / parentTurnId / rootTurnId / toolOutput …
  cwd?: string | null,
  approvalPolicy?: AskForApproval | null,
  approvalsReviewer?: ApprovalsReviewer | null,
  sandboxPolicy?: SandboxPolicy | null,        // structured object, NOT the "read-only" string
  model?: string | null,
  serviceTier?: string | null | null,
  serviceTierForTurn?: string | null,
  effort?: ReasoningEffort | null,
  summary?: ReasoningSummary | null,
  outputSchema?: JsonValue | null
};
```

`v2/UserInput.ts` (text variant the plugin builds, `codex.mjs:86-88`):

```ts
{ "type": "text", text: string, text_elements: Array<TextElement> }
```

`v2/ReviewStartParams.ts` / `v2/ReviewTarget.ts` / `v2/ReviewDelivery.ts`:

```ts
export type ReviewStartParams = { threadId: string, target: ReviewTarget,
  delivery?: ReviewDelivery | null };
export type ReviewTarget =
  | { "type": "uncommittedChanges" }
  | { "type": "baseBranch", branch: string }
  | { "type": "commit", sha: string, title: string | null }
  | { "type": "custom", instructions: string };
export type ReviewDelivery = "inline" | "detached";   // detached deprecated
```

`v2/ThreadListParams.ts` (relevant fields):

```ts
export type ThreadListParams = {
  cursor?: string | null, limit?: number | null,
  sortKey?: ThreadSortKey | null,          // "created_at" | "updated_at" | "recency_at" | "section_position"
  sortDirection?: SortDirection | null,
  sourceKinds?: Array<ThreadSourceKind> | null,
  /* "Optional source filter; when set, only sessions from these source kinds are
      returned. When omitted or empty, defaults to interactive sources." */
  archived?: boolean | null,
  cwd?: string | Array<string> | null,
  useStateDbOnly?: boolean,
  searchTerm?: string | null,
  /* + excludedThreadIds, modelProviders, originators, sectionId */
};
export type ThreadSourceKind = "cli" | "vscode" | "exec" | "appServer" | "subAgent" |
  "subAgentReview" | "subAgentCompact" | "subAgentThreadSpawn" | "subAgentOther" | "unknown";
```

`v2/AskForApproval.ts` (unchanged JSON values, new granular object):

```ts
export type AskForApproval = "untrusted" | { "granular": {...} } | "on-request" | "never";
```

`v2/SandboxMode.ts` (string accepted by `thread/start.sandbox`):

```ts
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
```

`v2/SandboxPolicy.ts` (structured object returned by `thread/start` and accepted by `turn/start.sandboxPolicy`):

```ts
export type SandboxPolicy = { "type": "dangerFullAccess" }
  | { "type": "readOnly", networkAccess: boolean }
  | { "type": "externalSandbox", networkAccess: NetworkAccess }
  | { "type": "workspaceWrite", writableRoots: Array<AbsolutePathBuf>, networkAccess: boolean,
      excludeTmpdirEnvVar: boolean, excludeSlashTmp: boolean };
```

Enums used by the plugin: `TurnStatus = "completed" | "interrupted" | "failed" | "inProgress"`
(`v2/TurnStatus.ts`); `MessagePhase = "commentary" | "partial_answer" | "final_answer"`
(`MessagePhase.ts`); `ReasoningEffort` is a free-form `string` (`ReasoningEffort.ts`), submitted as
`turn/start.effort` (e.g. `"low"` accepted).

Auth/config types:

```ts
export type GetAccountParams = { refreshToken?: boolean };            // v2/GetAccountParams.ts
export type GetAccountResponse = { account: Account | null, requiresOpenaiAuth: boolean,
                                   /* + workspaceRouting */ };
export type Account = { "type": "apiKey" } | { "type": "chatgpt", email: string | null, planType: PlanType }
                    | { "type": "amazonBedrock", usesCodexManagedCredentials: boolean };
export type GetAuthStatusParams = { includeToken: boolean | null, refreshToken: boolean | null };
export type GetAuthStatusResponse = { authMethod: AuthMode | null, authToken: string | null,
                                      requiresOpenaiAuth: boolean | null };
export type ConfigReadParams = { includeLayers?: boolean, cwd?: string | null };
export type ConfigReadResponse = { config: Config, origins: {...}, layers: Array<ConfigLayer> | null };
```

`ExternalAgentConfigImportParams` / `MigrationDetails` (the plugin's payload shape):

```ts
export type ExternalAgentConfigImportParams = {
  migrationItems: Array<ExternalAgentConfigMigrationItem>,   // itemType: AGENTS_MD|CONFIG|SKILLS|
  /* + optional source, providerId, migrationSource */        // PLUGINS|MCP_SERVER_CONFIG|SUBAGENTS|
};                                                            // HOOKS|COMMANDS|MEMORY|SESSIONS
export type ExternalAgentConfigMigrationItem = { itemType: ..., description: string,
  cwd: string | null, details: MigrationDetails | null };
export type MigrationDetails = { plugins: Array<PluginsMigration>,
  skills: Array<SkillMigration>, sessions: Array<SessionMigration>,
  mcpServers: Array<McpServerMigration>, hooks: Array<HookMigration>,
  subagents: Array<SubagentMigration>, commands: Array<CommandMigration>, memory?: Array<string> };
export type SessionMigration = { path: string, cwd: string, title: string | null };
```

Thread/turn/notification shapes the plugin's capture logic relies on (`v2/ThreadItem.ts`, `v2/Turn.ts`,
`v2/Thread.ts`): `agentMessage {text, phase}`, `reasoning {summary, content}`,
`enteredReviewMode {review}` / `exitedReviewMode {review}`, `commandExecution {command, status, exitCode}`,
`fileChange {changes: FileUpdateChange[]}` with `FileUpdateChange {path, kind, diff}`,
`mcpToolCall {server, tool, status}`, `dynamicToolCall {tool, status}`, `webSearch` (`WebSearchItem.query`),
`collabAgentToolCall {tool, status, receiverThreadIds}` — all still present with the same field names.
`Turn` now also has `rootTurnId`, `itemsView`, `startedAt`, `completedAt`, `durationMs` (additive);
`Thread` still has `name`, `agentNickname`, `agentRole`, `source` (`SessionSource`), `cwd`, `ephemeral`.

### 3.3 Full method inventory (compact)

Client requests (108, `ClientRequest.ts`):

```
initialize, thread/start, thread/resume, thread/fork, thread/archive, thread/delete, thread/unsubscribe,
thread/name/set, thread/goal/set, thread/goal/get, thread/goal/clear, thread/metadata/update,
thread/attachment/add, thread/attachment/list, thread/attachmentOwner/list, thread/attachment/remove,
thread/section/move, thread/unarchive, thread/compact/start, thread/shellCommand,
thread/approveGuardianDeniedAction, thread/revert, thread/list, threadSection/list, threadSection/create,
threadSection/update, threadSection/delete, thread/loaded/list, thread/read, thread/turns/list,
thread/items/list, thread/inject_items, skills/list, skills/extraRoots/set, hooks/list, marketplace/add,
marketplace/remove, marketplace/upgrade, plugin/list, plugin/installed, plugin/reconcile, plugin/read,
plugin/skill/read, plugin/share/save, plugin/share/updateTargets, plugin/share/list, plugin/share/checkout,
plugin/share/delete, app/read, app/list, app/installed, fs/readFile, fs/writeFile, fs/createDirectory,
fs/getMetadata, fs/readDirectory, fs/remove, fs/copy, fs/watch, fs/unwatch, skills/config/write,
plugin/install, plugin/uninstall, turn/start, turn/steer, turn/interrupt, review/start, model/list,
account/gatewayOAuth/read, account/gatewayOAuth/login, account/gatewayOAuth/cancel,
modelProvider/capabilities/read, experimentalFeature/list, permissionProfile/list,
experimentalFeature/enablement/set, mcpServer/oauth/login, config/mcpServer/reload, mcpServerStatus/list,
mcpServer/resource/read, mcpServer/tool/call, windowsSandbox/setupStart, windowsSandbox/readiness,
account/login/start, account/login/cancel, account/logout, account/rateLimits/read,
account/rateLimitResetCredit/consume, account/usage/read, account/workspaceMessages/read,
account/sendAddCreditsNudgeEmail, feedback/upload, command/exec, command/exec/write,
command/exec/terminate, command/exec/resize, config/read, externalAgentConfig/detect,
externalAgentConfig/import, externalAgentConfig/import/recordHistory,
externalAgentConfig/import/readHistories, config/value/write, config/batchWrite, configRequirements/read,
account/read, getConversationSummary, gitDiffToRemote, getAuthStatus, fuzzyFileSearch
```

Server notifications (87, `ServerNotification.ts`) include everything the plugin consumes
(`error`, `thread/started`, `thread/name/updated`, `turn/started`, `turn/completed`, `item/started`,
`item/completed`, the four delta methods it opts out of) plus new ones the plugin could adopt
(`turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated`, `deprecationNotice`, `warning`,
`configWarning`, `externalAgentConfig/import/progress`, `account/rateLimits/updated`, …).

Server requests (10, `ServerRequest.ts`) — the plugin currently answers every one with
`-32601 Unsupported server request`:

```
item/commandExecution/requestApproval, item/fileChange/requestApproval, item/tool/requestUserInput,
mcpServer/elicitation/request, item/permissions/requestApproval, item/tool/call,
account/chatgptAuthTokens/refresh, attestation/generate, applyPatchApproval, execCommandApproval
```

---

## 4. Captured flows

All payloads below are real captures; the full JSON is in the linked report files.

### 4.1 Turn (plugin's exact request shapes) — ✅ works

Request (`report-appserver.json`):

```jsonc
// thread/start  (plugin buildThreadParams: cwd, model:null, approvalPolicy:"never",
//                sandbox:"read-only", serviceName, ephemeral:true)
{"cwd":"/tmp/…","model":null,"approvalPolicy":"never","sandbox":"read-only",
 "serviceName":"claude_code_codex_plugin","ephemeral":true}
// response (trimmed)
{"thread":{"id":"01a153c2-60ea-…","ephemeral":true,"source":"vscode","cwd":"/tmp/…",
           "status":{"type":"idle"},"historyMode":"paginated","originator":"Claude Code", …},
 "model":"gpt-6.1-sol","modelProvider":"openai","serviceTier":null,
 "approvalPolicy":"never","approvalsReviewer":"user",
 "sandbox":{"type":"readOnly","networkAccess":false},"reasoningEffort":null,
 "instructionSources":[],"runtimeWorkspaceRoots":["/tmp/…"],"disabledPluginIds":[]}

// turn/start (plugin runAppServerTurn)
{"threadId":"01a153c2-60ea-…",
 "input":[{"type":"text","text":"Reply with exactly: OK","text_elements":[]}],
 "model":null,"effort":null,"outputSchema":null}
// response
{"turn":{"id":"01a153c2-623b-…","rootTurnId":"01a153c2-623b-…","items":[],
         "itemsView":"notLoaded","status":"inProgress","error":null,
         "startedAt":null,"completedAt":null,"durationMs":null}}
```

Notification sequence observed for the turn (`report-appserver.json` → `turnStart.notifications`):

```
turn/started            (turn.status inProgress)
item/started            (userMessage)
item/completed          (userMessage)
item/started            (agentMessage, text:"" , phase:"final_answer")
item/completed          (agentMessage, text:"OK", phase:"final_answer")
turn/completed          (turn.status "completed", durationMs 7552, items include the agentMessage)
```

Final `turn/completed` payload (`report-appserver.json` → `turnStart.completedNotification`):

```json
{"threadId":"01a153c2-60ea-…","turn":{"id":"01a153c2-623b-…",
 "rootTurnId":"01a153c2-623b-…",
 "items":[{"type":"agentMessage","id":"msg_…","text":"OK","phase":"final_answer",
           "memoryCitation":null,"delivery":null,"questions":null}],
 "itemsView":"summary","status":"completed","error":null,
 "startedAt":1792406610,"completedAt":1792406618,"durationMs":7552}}
```

The plugin's `captureTurn`/`recordItem` logic consumed this correctly when run unmodified (§4.8).
`agentMessage.phase` is still `"final_answer"` for normal task turns. Structured output also works:
`turn/start` asked for `{"summary":string,"verdict":"pass"|"fail"}` with `effort:"low"` and returned
`{"summary":"ok","verdict":"pass"}` as the `final_answer` message (`report-output-schema.json`).

### 4.2 Interrupt — ✅ works

```jsonc
// -> second thread/turn, then:
{"threadId":"01a153c2-7fe9-…","turnId":"01a153c2-8006-…"}    // turn/interrupt
// <- {}
// following notification
{"threadId":"01a153c2-7fe9-…","turn":{"id":"01a153c2-8006-…","rootTurnId":"01a153c2-8006-…",
 "items":[],"itemsView":"notLoaded","status":"interrupted","error":null,
 "startedAt":1792406618,"completedAt":1792406619,"durationMs":1203}}
```

`turn/interrupt` result is `{}`; completion arrives as `turn/completed` with `status:"interrupted"`.
`buildResultStatus` (`codex.mjs:754-756`) maps that to exit status 1, as intended.

### 4.3 Review (`review/start`, inline, uncommitted changes) — ✅ works

Scratch repo with an off-by-one `sumTo` and a bad `applyDiscount`, one uncommitted change
(`report-review.json`; `sandbox:"danger-full-access"` only because of the probe sandbox, see §1):

```jsonc
// review thread/start: cwd, model:null, approvalPolicy:"never", sandbox:"read-only" (probe used
// danger-full-access), serviceName, ephemeral:true, no thread name
// -> review/start (plugin runAppServerReview)
{"threadId":"01a153c3-b399-…","delivery":"inline",
 "target":{"type":"uncommittedChanges"}}
// <- response: note turn.rootTurnId is null in review responses
{"turn":{"id":"01a153c3-b3bf-…","rootTurnId":null,
  "items":[{"type":"userMessage","id":"…","clientId":null,
            "content":[{"type":"text","text":"current changes","text_elements":[]}]}],
  "itemsView":"notLoaded","status":"inProgress","error":null},
 "reviewThreadId":"01a153c3-b399-…"}          // inline => same as source thread id
```

Notification sequence: `deprecationNotice` is **not** emitted for inline; `item/started`+
`item/completed` pairs for `enteredReviewMode`, `userMessage`, `reasoning`, MCP tool calls, then the
review text as **both** an `exitedReviewMode` item and an `agentMessage` with `phase: null`; finally
`turn/completed` (`status:"completed"`, `durationMs: 22203`).

```jsonc
// item/completed exitedReviewMode
{"type":"exitedReviewMode","id":"01a153c4-0a7b-…","review":"The changes introduce an off-by-one
 regression in sumTo and a discount function that increases positive prices.…\n\nFull review comments:\n
 - [P2] Include the upper bound in sumTo — …/src/math.js:3-3 …\n- [P2] Reduce the price when applying a
 discount — …/src/discount.js:2-2 …"}
```

The plugin's `recordItem` path (`codex.mjs:449-461`) reads `exitedReviewMode.review`, so review output
capture is intact. `delivery:"detached"` is deprecated:

```jsonc
// emitted only for detached delivery (report-threadlist.json -> reviewDeprecation)
{"summary":"review/start with delivery \"detached\" is deprecated and will be removed in a future release.",
 "details":"Use thread/start followed by review/start with delivery \"inline\" for a separate review
            thread, or thread/fork followed by turn/start with your own review instructions."}
```

**Custom prompt / output schema checks** (no model call, bogus thread id so the request fails at thread
load, before any review runs — `report-appserver.json` → `paramValidation`):

| Request | Result | Meaning |
| --- | --- | --- |
| `target:{"type":"custom","instructions":"Focus only on src/math.js"}` | `thread not found` | custom instructions are a valid 0.163 target |
| same + `"outputSchema":{…}` | `thread not found` (unknown field silently ignored) | **`review/start` has no outputSchema**; a schema must go through `turn/start` |
| `target:{"type":"baseBranch","branch":"main"}` / `commit` | `thread not found` | all target variants accepted |
| `target:{"type":"notARealTarget"}` | `Invalid request: unknown variant … expected one of uncommittedChanges, baseBranch, commit, custom` (-32600) | target enum is strict |
| `delivery:"detached"` | accepted + deprecationNotice | deprecated but functional |

### 4.4 Auth, account, config, rate limits — ✅ works

`report-appserver.json` → `auth` (probe home had no `config.toml`, so config values are null):

The generated `GetAccountResponse.ts` declares `{account, requiresOpenaiAuth}`, but the runtime
response also carries an untyped/ungenerated `workspaceRouting` object — additive, ignored by the plugin:

```jsonc
// getAuthStatus {includeToken:false, refreshToken:false}
{"authMethod":"chatgpt","authToken":null,"requiresOpenaiAuth":true}

// account/read {refreshToken:false}
{"account":{"type":"chatgpt","email":"a…@gmail.com","planType":"plus"},
 "requiresOpenaiAuth":true,
 "workspaceRouting":{"chatgptAccountId":"<redacted>","backendOrigin":"https://chatgpt.com",
                     "accountRoutingOverride":"NO_CONSTRAINT"}}  // not in generated GetAccountResponse.ts

// config/read {includeLayers:false, cwd}
{"config":{ /* snake_case Config incl. model, model_provider, approval_policy, sandbox_mode,
              model_reasoning_effort, service_tier, instructions, developer_instructions,
              model_providers, mcp_servers, … */ },
 "origins":{}, "layers": null}

// account/rateLimits/read {}
{"ordinaryUsageAllowed":true,
 "rateLimits":{"limitId":"codex","primary":{"usedPercent":3,"windowDurationMins":300,"resetsAt":…},
               "secondary":{"usedPercent":48,"windowDurationMins":10080,"resetsAt":…},
               "credits":{"hasCredits":false,"unlimited":false,"balance":"0"},
               "planType":"plus"},
 "rateLimitsByLimitId":{"codex":{…}},
 "rateLimitResetCredits":{"availableCount":1,"credits":[…]},
 "accountId":"<redacted>"}
```

The plugin's `buildAppServerAuthStatus` reads `account.type/email` and `requiresOpenaiAuth` — both unchanged.
`config/read`'s `config` object keeps `model_provider` / `model_providers` (snake_case) that
`resolveProviderConfig` uses. with `includeLayers:false`, `config/read` returns only `{config, origins}` — the `layers` key is absent
(the plugin does not read it).

### 4.5 Thread persistence, resume and listing — ⚠️ listing drift

Created three threads with plugin params in a fresh `CODEX_HOME`
(`report-threadlist.json`):

| thread | request | response `thread.source` | response `threadSource` | `name/set` |
| --- | --- | --- | --- | --- |
| ephemeral | `ephemeral:true` | `"vscode"` | `null` | ❌ `ephemeral thread does not support metadata updates` (-32600) |
| persistent | `ephemeral:false` | `"vscode"` | `null` | ✅ `{}` |
| persistent + `threadSource:"appServer"` | `ephemeral:false, threadSource:"appServer"` | `"vscode"` | `"appServer"` | ✅ `{}` |

`thread/list` matrix (all with the plugin's `limit:20, sortKey:"updated_at"`):

| list params | before any turn | after persistent thread has one turn |
| --- | --- | --- |
| plugin params: `cwd, sourceKinds:["appServer"], searchTerm:"Codex Companion Task"` | 0 | **0** |
| `cwd, searchTerm` (no sourceKinds) | 0 | 1 (correct thread) |
| `cwd, sourceKinds:["vscode"]` | 0 | 1 (correct thread) |
| `cwd` only | 0 | 1 |
| no filters | 0 | 1 |

Two independent findings:

1. **Threads created through `thread/start` are recorded with `source:"vscode"`, not `"appServer"`.**
   `threadSource:"appServer"` only populates `thread.threadSource`; it does not change the filterable
   `thread.source` (typed as `SessionSource`, which has `vscode` but no `appServer`). The plugin's
   `findLatestTaskThread` filters `sourceKinds:["appServer"]` and therefore always returns nothing.
   Omitting `sourceKinds` defaults to "interactive sources" and finds the thread.
2. **`thread/list` only returns threads that have at least one persisted turn.** A persistent, named
   thread that has never run a turn is invisible to `thread/list` (but `thread/resume` by id works). That
   is fine for the plugin's fallback (task threads always run a turn) but explains empty early lists.

`thread/resume` on the persistent thread returned the standard `ThreadResumeResponse` (keys added:
`runtimeWorkspaceRoots`, `activePermissionProfile`, `collaborationMode`, `multiAgentMode`,
`initialTurnsPage`, `turnsBackwardsCursor`, `itemsBackwardsCursor`) and resumed the named thread correctly.
Resuming an **ephemeral** thread fails: `no rollout found for thread id …` (-32600); ephemeral threads are
not resumable and never appear in `thread/list` — matches the plugin's design (ephemeral review threads,
persistent task threads).

### 4.6 `externalAgentConfig/import` — ⚠️ type drift, runtime tolerant

`report-import.json`. The plugin payload (`codex.mjs:681-699`) is accepted as-is, even though 0.163's
`MigrationDetails` declares `skills` as a required array while the plugin omits it:

```jsonc
// plugin payload (accepted)
{"migrationItems":[{"itemType":"SESSIONS","description":"Transfer Claude session …","cwd":null,
  "details":{"plugins":[],"sessions":[{"path":"/tmp/…/fake-claude-session.jsonl","cwd":"/tmp/…",
             "title":null}],"mcpServers":[],"hooks":[],"subagents":[],"commands":[]}}]}
// <- {"importId":"85a2320e-…"}
// then: externalAgentConfig/import/progress and /completed notifications, e.g.
{"importId":"85a2320e-…","itemTypeResults":[{"itemType":"SESSIONS","successes":[],
  "failures":[{"itemType":"SESSIONS","errorType":null,"subErrorType":"session_not_detected",
               "failureStage":"session_missing","message":"external agent session was not detected …",
               "cwd":null,"source":"/tmp/…/fake-claude-session.jsonl"}]}]}
```

The synthetic session file was rejected as `session_not_detected` (expected — it is not a real Claude
session), but the protocol path and notification names are intact. Add `"skills":[]` to match the declared
type and consume `import/progress`/`itemTypeResults` if useful. `rootTurnId` is `null` in review-start turns.

### 4.7 Native unix-socket transport and daemon (broker replacement potential)

`report-unix-listen.json`:

- `codex app-server --listen unix:///tmp/…/app-server.sock` creates the socket and speaks **WebSocket**
  (HTTP/1.1 `101 Switching Protocols`) over the unix socket; each WS text frame carries one JSON-RPC
  message. Plain newline-delimited JSON on the raw socket is closed immediately.
- Two independent WebSocket clients initialized and created threads concurrently against one server:
  `codexHome`/`platformFamily` response captured, both `thread/start` calls returned distinct
  `source:"vscode"` ephemeral threads. This is a native equivalent of the plugin's broker multiplexing.
- Bare `--listen unix://` listens on `$CODEX_HOME/app-server-control/app-server-control.sock`; same WS
  handshake and initialize/thread-start flow worked.
- `codex app-server proxy --sock <socket>` launched and held the connection, but produced no output for a
  JSONL `initialize` within 4 s (inconclusive: it likely expects the daemon-managed control protocol).
- `codex app-server daemon start` fails in this sandbox (`failed to invoke ps for pid-managed app server:
  Operation not permitted`), so daemon-managed mode is unverified; `daemon version` without a running
  daemon errors with the control-socket path.
- Relevant CLI surface: `codex app-server daemon {start,stop,restart,version,…}`,
  `codex app-server proxy --sock <path>`, `codex agents` (browses sessions on the shared local app-server
  daemon, accepts `--remote unix://PATH`), and `--listen unix://PATH|ws://IP:PORT` options on
  `codex app-server`.

### 4.8 Unmodified plugin code against 0.163 — ✅ works

`report-plugin-client.json`: the probe imports the plugin's real `codex.mjs` / `app-server.mjs` /
`broker-lifecycle.mjs` (no edits) and runs them against `codex-cli 0.163.0` with a writable `CODEX_HOME`:

```jsonc
availability: {"available":true,"detail":"codex-cli 0.163.0; advanced runtime available"}
authStatus:   {"loggedIn":true,"detail":"ChatGPT login active for a…@gmail.com",
               "source":"app-server","authMethod":"chatgpt","verified":true,"requiresOpenaiAuth":true}
broker:       endpoint $TMPDIR/cxc-lkKN2w/broker.sock created and cleanly shut down (broker transport used)
runAppServerTurn (persistThread:true, name "Codex Companion Task: plugin-client probe", read-only):
  {"status":0,"threadId":"01a153cb-208b-…","turnId":"01a153cb-21ff-…","finalMessage":"OK",
   "turnStatus":"completed","stderr":"","progressEvents":5}
findLatestTaskThread(cwd): null        // <-- drift: thread/list sourceKinds:["appServer"] filter
```

The five progress events show the plugin's notification pipeline working unchanged:
`Starting Codex task thread.` → `Thread ready (…)` → `Turn started (…)` → `Assistant message captured: OK`
→ `Turn completed.`.

So: **broker, handshake, thread create/name, turn start, notification capture, result building and auth
status all work as-is**; only the legacy `thread/list` lookup came back empty.

---

## 5. Drift table (plugin assumption → 0.163 reality → patch)

Legend: **BREAKS** = plugin flow fails; **DEGRADED** = silently returns no result;
**LATENT** = fails only on a path not taken by today's callers; **COSMETIC**; **NO CHANGE**.

| # | Area (plugin code) | 0.163 reality (evidence) | Impact | Minimal patch (old → new) |
| --- | --- | --- | --- | --- |
| D1 | `findLatestTaskThread` sends `thread/list` with `sourceKinds:["appServer"]` (`codex.mjs:1169-1175`) | Threads made by `thread/start` persist `thread.source:"vscode"`; `threadSource:"appServer"` only sets `thread.threadSource`; list with `sourceKinds:["appServer"]` returns 0 even for a named, turn-bearing task thread (`report-threadlist.json` lists; real plugin function returned `null` in `report-plugin-client.json`) | **DEGRADED** — `--resume-last` fallback (no Claude session id) can never find a thread | Remove `sourceKinds: ["appServer"]` (defaults to interactive sources and finds it) or use `sourceKinds: ["vscode","cli","exec"]`; keep `cwd`/`searchTerm`/`sortKey`; note list only shows threads that ran ≥1 turn |
| D2 | `startThread` calls `thread/name/set` whenever `threadName` is set, even for `ephemeral:true` (`codex.mjs:732-748`, catch only matches "unknown variant/method") | Ephemeral threads reject metadata updates: `-32600 "ephemeral thread does not support metadata updates: <id>"` (`report-appserver.json`, `report-threadlist.json`) | **LATENT** — today's task path uses `persistThread:true` and review passes no name; any future named-ephemeral call throws | Only call `thread/name/set` when `ephemeral === false`, or add a non-fatal branch: skip/ignore when message includes `"ephemeral thread does not support metadata updates"` |
| D3 | `thread/resume` used for persistent tasks only (`codex.mjs:750-752`, `1104-1111`) | Persistent resume works; ephemeral resume fails `no rollout found` (`report-appserver.json`) | **NO CHANGE** for current callers | No change; guard errors if ever resuming ephemeral ids |
| D4 | `app-server-protocol.d.ts` maps only 9 methods; `account/read`, `config/read` called untyped; `Omit<…,"persistExtendedHistory">` refers to a field that no longer exists | 0.163 `ThreadStartParams`/`ThreadResumeParams` have no `persistExtendedHistory`; `account/read`/`config/read` are real methods (`ClientRequest.ts`) | **COSMETIC/type-only** (`.mjs` is untyped); regeneration against 0.163 keeps `Omit` harmless but pointless | Regenerate `.generated/app-server-types` from 0.163 (`generate-ts`); drop the `Omit<…,"persistExtendedHistory">` wrappers; add `account/read`, `config/read`, `getAuthStatus`, `account/rateLimits/read`, `thread/delete` to `AppServerMethodMap` |
| D5 | Broker's fake `initialize` result is `{userAgent:"codex-companion-broker"}` (`app-server-broker.mjs:146-153`) | Real 0.163 result adds `codexHome`, `platformFamily`, `platformOs` (`report-appserver.json`) | **LATENT** — plugin ignores them today; breaks if it starts using them | Extend broker's fake result with the same fields (or proxy the real initialize result from its app-server client) |
| D6 | `captureTurn` handles `exitedReviewMode` item text (`codex.mjs:449-461`) | Review output arrives as `exitedReviewMode.review` **and** a duplicate `agentMessage` with `phase:null`; inline delivery is fine; only `detached` is deprecated | **NO CHANGE** (verified emitted/captured) | No change; can prefer `exitedReviewMode.review` (already does) and ignore phase-null messages for review |
| D7 | Plugin replies `-32601` to every server→client request (`app-server.mjs:156-161`) | 0.163 has 10 server requests incl. `item/tool/requestUserInput`, `mcpServer/elicitation/request`, approvals (`ServerRequest.ts`) | **RISK** if a turn/tool elicits user input: request is rejected, tool fails (turn usually continues). Approval requests are not expected with `approvalPolicy:"never"` | Keep -32601 for approvals; consider handling `item/tool/requestUserInput`/`mcpServer/elicitation/request` (or disable MCP for plugin threads via `thread/start.config`) |
| D8 | `cleanCodexStderr` filters `"WARNING: proceeding, even though we could not update PATH:"` (`codex.mjs:54-60`) | 0.163 emits `"WARNING: proceeding, even though we could not create PATH aliases: …"` in constrained environments | **COSMETIC** (noise in `stderr` field) | Update the filter prefix, e.g. match `could not (update PATH|create PATH aliases)` |
| D9 | `modelReasoningEffort` (REST-style name) is not sent by the plugin today — but if someone adds it to `thread/start`, it is silently ignored | `thread/start` accepts `model` (top-level) and `config` (arbitrary config keys); the **turn-level** knob is `effort`; unknown top-level fields are ignored (`report-appserver.json` paramValidation: `modelReasoningEffort:"low"` → response `reasoningEffort:null`; `config:{model_reasoning_effort:"low"}` → response `reasoningEffort:"low"`) | **INFO** | Send `effort` on `turn/start` (plugin already does), or `config:{"model_reasoning_effort":"low"}` on `thread/start`/`thread/resume`; never `modelReasoningEffort` |
| D10 | `serviceTier` is never sent by the plugin | 0.163 supports `thread/start.serviceTier`, `thread/resume.serviceTier`, `turn/start.serviceTier` and `turn/start.serviceTierForTurn`; default `null` | **NO CHANGE** | If needed: add `serviceTier` to `thread/start`/`thread/resume` params (plugin options pass-through) |
| D11 | `externalAgentConfig/import` payload omits `details.skills` (`codex.mjs:681-699`) | Declared `MigrationDetails.skills` is required (`v2/MigrationDetails.ts`) but the runtime accepted the payload (`report-import.json`); progress+completed notifications exist and carry `itemTypeResults` with failures | **INFO/RISK** (runtime tolerant today; may become strict) | Add `skills: []`; optionally read `itemTypeResults` from `externalAgentConfig/import/completed` instead of relying solely on the ledger file |
| D12 | Turn item / Thread fields consumed by capture and labels | All still present: `agentMessage.text/phase`, `reasoning.summary`, `commandExecution.command/exitCode/status`, `fileChange.changes[].path`, `mcpToolCall.server/tool/status`, `dynamicToolCall.tool/status`, `collabAgentToolCall.tool/status/receiverThreadIds`, `webSearch.query`, `thread.name/agentNickname/agentRole` | **NO CHANGE** | None |
| D13 | Notification methods subscribed: `thread/started`, `thread/name/updated`, `turn/started`, `item/started`, `item/completed`, `turn/completed`, `error` | All 7 are in 0.163's 87 `ServerNotification` methods and were observed (except `error` in happy paths) | **NO CHANGE** | Optionally adopt `turn/diff/updated`, `thread/tokenUsage/updated`, `deprecationNotice`, `warning` for richer UI |
| D14 | `thread/start` response treated as `{thread:{id,…}}` only | Response adds `model`, `modelProvider`, `serviceTier`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `activePermissionProfile`, `reasoningEffort`, `runtimeWorkspaceRoots`, `multiAgentMode`, `disabledPluginIds`, `instructionSources`; **the response's top-level `sandbox` is a structured `SandboxPolicy` object, not the `"read-only"` string that was sent** | **NO CHANGE** (plugin reads `.thread.id` only) | No change; don't echo response `sandbox` back as `SandboxMode` |
| D15 | Broker spawns a node broker that spawns `codex app-server` with no args (`broker-lifecycle.mjs:59-70`, `app-server.mjs:190-196`) | No-arg stdio app-server still valid. Native alternatives now exist: `codex app-server --listen unix://PATH` (WS over unix, multiple concurrent clients), `daemon` + `proxy`, `codex agents --remote unix://` | **NO CHANGE** (works); strategic option | Short term: none. Medium term: replace custom broker with native `--listen unix://` + a small RFC6455 client in `app-server.mjs` (validates concurrent clients; removes pid/state/busy bookkeeping). Keep busy/queue semantics: native server accepts concurrent clients rather than rejecting them with `-32001` |
| D16 | `thread/list` response consumed as `{data:[...]}` | Response keys: `data`, `readStates`, `backwardsCursor`, `nextCursor`; `Thread.source` for these threads is `"vscode"` | **NO CHANGE** | None beyond D1 |
| D17 | initialize `experimentalApi:false` default (`app-server.mjs:32-42`) | No used method requires experimental API; opt-out method names all valid (`report-appserver.json`, `report-review.json`) | **NO CHANGE** | None required. If new methods are adopted, check `experimentalApi` gating then |
| D18 | `getAuthStatus` legacy vs `account/read`+`config/read` | `getAuthStatus` still exists with same params/result; `account/read` response adds `workspaceRouting`; `config/read` shape compatible | **NO CHANGE** | No change; could additionally surface `workspaceRouting` / `planType` |

---

## 6. Recommended request shapes for 0.163

All examples use the plugin's existing JSON-RPC dialect (no `jsonrpc` field), exactly as captured.

```jsonc
// 1) Handshake (unchanged)
{"id":1,"method":"initialize","params":{
  "clientInfo":{"name":"Claude Code","title":"Codex Plugin","version":"1.0.6"},
  "capabilities":{"experimentalApi":false,"requestAttestation":false,
    "optOutNotificationMethods":["item/agentMessage/delta","item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded","item/reasoning/textDelta"]}}}
{"method":"initialized","params":{}}

// 2) Review thread + review (native reviewer, current target variants)
{"id":2,"method":"thread/start","params":{
  "cwd":"/abs/repo","model":null,"approvalPolicy":"never","sandbox":"read-only",
  "serviceName":"claude_code_codex_plugin","ephemeral":true}}
{"id":3,"method":"review/start","params":{"threadId":"<id>","delivery":"inline",
  "target":{"type":"uncommittedChanges"}}}
//   target alternatives: {"type":"baseBranch","branch":"main"}
//                        {"type":"commit","sha":"<sha>","title":null}
//                        {"type":"custom","instructions":"<custom review prompt>"}
//   custom instructions are supported by 0.163; review/start has NO outputSchema.
//   Do not use delivery:"detached" (deprecated).

// 3) Persistent task thread (name only after it is non-ephemeral)
{"id":4,"method":"thread/start","params":{
  "cwd":"/abs/repo","model":null,"approvalPolicy":"never","sandbox":"read-only",
  "serviceName":"claude_code_codex_plugin","ephemeral":false,
  "config":{"model_reasoning_effort":"low"},          // optional; any config.toml key
  "developerInstructions":"…"}}                        // optional (also baseInstructions)
{"id":5,"method":"thread/name/set","params":{"threadId":"<persistent-id>",
  "name":"Codex Companion Task: <prompt excerpt>"}}

// 4) Turn (model/effort/outputSchema overrides live here)
{"id":6,"method":"turn/start","params":{
  "threadId":"<id>","input":[{"type":"text","text":"…","text_elements":[]}],
  "model":null,"effort":"low","outputSchema":null}}
//   optional: sandboxPolicy:{"type":"readOnly","networkAccess":false} (structured!),
//             approvalPolicy, serviceTier, serviceTierForTurn, summary, cwd.

// 5) Interrupt
{"id":7,"method":"turn/interrupt","params":{"threadId":"<id>","turnId":"<id>"}}

// 6) Resume a persistent thread
{"id":8,"method":"thread/resume","params":{"threadId":"<persistent-id>","cwd":"/abs/repo",
  "model":null,"approvalPolicy":"never","sandbox":"read-only"}}
//   (ThreadResumeParams has no ephemeral field; ephemeral threads are not resumable)

// 7) Find latest task thread in 0.163 — DROP sourceKinds:["appServer"]
{"id":9,"method":"thread/list","params":{"cwd":"/abs/repo","limit":20,"sortKey":"updated_at",
  "searchTerm":"Codex Companion Task"}}
//   add "sourceKinds":["vscode"] if an explicit filter is desired; omitting defaults to
//   interactive sources. Only threads with >=1 persisted turn are returned.

// 8) Auth / account / config / rate limits
{"id":10,"method":"account/read","params":{"refreshToken":false}}
{"id":11,"method":"config/read","params":{"includeLayers":false,"cwd":"/abs/repo"}}
{"id":12,"method":"account/rateLimits/read","params":{}}
//   legacy: {"id":13,"method":"getAuthStatus","params":{"includeToken":false,"refreshToken":false}}

// 9) Claude-session import (add skills:[], keep the rest)
{"id":14,"method":"externalAgentConfig/import","params":{"migrationItems":[{
  "itemType":"SESSIONS","description":"Transfer Claude session <name>","cwd":null,
  "details":{"plugins":[],"skills":[],"sessions":[{"path":"<abs path>","cwd":"<repo>",
    "title":null}],"mcpServers":[],"hooks":[],"subagents":[],"commands":[]}}]}}
//   then wait for externalAgentConfig/import/completed (id importId, itemTypeResults[]).
```

How parameters map in 0.163 (the plugin's options today):

| Plugin option | Where it goes now | 0.163 requirement |
| --- | --- | --- |
| `model` | `thread/start.model`, `thread/resume.model`, `turn/start.model` (all optional, `null` = config default) | unchanged |
| `effort` | `turn/start.effort` (`ReasoningEffort` string) | unchanged; do **not** send `modelReasoningEffort` top-level |
| `serviceTier` (not used) | `thread/start.serviceTier` / `turn/start.serviceTier` / `serviceTierForTurn` | new capability; `null` default |
| `approvalPolicy` | `thread/start` / `thread/resume` / `turn/start` (`AskForApproval`); plugin sends `"never"` | unchanged string enum |
| `sandbox` (thread) | `thread/start.sandbox` / `thread/resume.sandbox`, string `SandboxMode` | unchanged strings `read-only`/`workspace-write`/`danger-full-access` |
| turn-level sandbox (not used) | `turn/start.sandboxPolicy`, **structured** `SandboxPolicy` | not the string form |
| `cwd` | `thread/start.cwd`, `thread/resume.cwd` | unchanged; response/persisted paths are realpaths (`/private/var/...` on macOS) |
| `developerInstructions` (not used) | `thread/start.developerInstructions` / `thread/resume.developerInstructions` (also `baseInstructions`) | supported |
| arbitrary config | `thread/start.config` / `thread/resume.config` (e.g. `{"model_reasoning_effort":"low"}`) | supported; unknown top-level params are ignored, not rejected |

---

## 7. Fallback options (no app-server)

### 7.1 `codex exec --json` / `codex exec review --json` — viable but narrower

Captured event stream (`codex exec --json -s danger-full-access --skip-git-repo-check "Reply with exactly: OK"`,
in this sandbox a non-default sandbox was needed for the same `sandbox-exec` reason as §1):

```jsonl
{"type":"thread.started","thread_id":"01a153c8-7ef0-7d31-ac86-7ed842b7f9ca"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":17531,"cached_input_tokens":0,
 "cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

Available flags (`probes/cli-help/exec-help.txt`): `--json`, `--output-schema <FILE>`, `-o/--output-last-message`,
`-m/--model`, `-s/--sandbox read-only|workspace-write|danger-full-access`, `-C/--cd`, `--add-dir`, `--ephemeral`,
`--skip-git-repo-check`, `--thread-source`, `--ignore-user-config`, `--ignore-rules`, plus
`codex exec resume --last|<SESSION_ID> [PROMPT]` (also `--json`, `--output-schema`) and
`codex exec fork`. `codex exec review --uncommitted|--base <ref>|--commit <sha> [PROMPT]` supports
custom prompt, `--json`, `--output-schema`, `-o`. Top-level `codex review` has fewer options (no `--json`).

Tradeoffs versus app-server:

| Capability | app-server (plugin today) | `codex exec --json` / `exec review --json` |
| --- | --- | --- |
| Streaming | fine-grained notifications: `item/started`, deltas (opt-in), `turn/plan/updated`, `turn/diff/updated` | coarse JSONL: `thread.started`, `turn.started`, `item.completed`, `turn.completed` (final message/usage); no interrupt RPC |
| Interrupt | `turn/interrupt` → `turn.completed{status:"interrupted"}` | signal the child process (SIGINT/SIGTERM) |
| Resume | `thread/resume` by id, persistent threads | `exec resume <id|--last>` (new process) |
| Background/shared runtime | long-lived app-server + broker socket; multiple clients; busy coordination | one process per run; caller manages backgrounding |
| Thread discovery | `thread/list` (with D1 caveat) | not exposed; resume by id/`--last` only |
| Auth/rate limits | `account/read`, `getAuthStatus`, `account/rateLimits/read` | not exposed by exec; `codex login status` (prints `Logged in using ChatGPT`), `codex doctor --json` (redacted health report) |
| Structured output | `turn/start.outputSchema` (verified honored) | `--output-schema <file>` |
| Approval/tool interaction | full server-request channel (plugin currently declines it) | CLI prompts/approvals handled by process flags; no client callback |

Recommendation: **keep the app-server integration** — it is the only surface that gives the plugin
turn interrupts, shared background runtime, thread discovery, structured auth/rate-limit data and
fine-grained progress. `codex exec --json` is a reasonable emergency fallback (e.g. app-server broken or
`experimentalApi`-gated in a future release) for **rescue** runs and, via `codex exec review --json`,
for **native review**; it cannot reproduce the plugin's interrupt/job/broker behavior without
re-architecting around child processes.

### 7.2 Native `--listen unix://` / `daemon` as broker replacement

- 0.163 has a first-class shared runtime: `codex app-server --listen unix://PATH` (WebSocket-over-unix
  JSON-RPC, multiple concurrent clients — verified) and a managed `daemon` (`daemon start|stop|restart|
  version`, control socket under `$CODEX_HOME/app-server-control/`). `codex agents` already browses that
  shared daemon and accepts `--remote unix://PATH`.
- This can replace the plugin's custom node broker (`app-server-broker.mjs` + `broker-lifecycle.mjs`):
  one native server, no custom socket/pid/state files, no fake `initialize`, no busy RPC code.
- Gaps to design around before switching: (a) the native server accepts concurrent clients rather than
  rejecting a second one with `-32001` (the plugin/broker relies on that "busy" contract for job
  serialization); (b) daemon start/stop lifecycle and stale-socket handling need re-testing outside this
  sandbox; (c) notifications are broadcast only to the connection that owns the thread in the plugin's
  current model — validate fan-out semantics; (d) the unix listener is WebSocket, not JSONL, so
  `app-server.mjs` needs a small RFC6455 client (no deps required; see `probes/probe-unix-listen.mjs`).
- Until those are validated on an unsandboxed host, **keep the existing broker**. It works on 0.163
  (verified end-to-end in §4.8).

---

## 8. Risks & open questions

1. **D1 is the only silently-degrading break**: the legacy task-thread discovery path
   (`--resume-last` when no Claude session id is available) returns nothing; patch before relying on it.
2. **Do not name ephemeral threads (D2).** Review threads are ephemeral by design; task threads are
   persistent. A future caller passing `threadName` with `ephemeral:true` will throw today.
3. **Server-request channel (D7)**: with `approvalPolicy:"never"` no approval requests are expected, but
   `item/tool/requestUserInput` / `mcpServer/elicitation/request` can appear for MCP tool use; the plugin
   answers `-32601`, so such a tool call fails (the turn generally continues). Consider disabling MCP for
   plugin threads via `thread/start.config` or handling those two requests.
4. **`review/start` cannot constrain output**: custom instructions are supported, output schemas are not
   (unknown fields ignored). Keep the existing split: `/codex:review` → `review/start` (native reviewer),
   adversarial review → `turn/start` + `outputSchema` (verified working).
5. **`thread/list` only returns threads with a persisted turn**, and `cwd` filtering is by path string —
   pass the realpath (`/private/var/...` on macOS) to be safe.
6. **Type generation must be refreshed**: `scripts/lib/app-server-protocol.d.ts` targets an older
   generated tree absent from this checkout; regenerate from 0.163 and add the methods called untyped.
   Runtime `.mjs` is not affected by the stale types.
7. **Auth state location**: the plugin spawns `codex` with the inherited environment, so `CODEX_HOME`
   (and `auth.json`/config) resolution is the user's shell environment. The probes only overrode
   `CODEX_HOME` to get a writable state DB inside the agent sandbox; that is not a plugin issue.
8. **Model/plan defaults**: reviewers ran with the account default `gpt-6.1-sol`; different plans/models
   may expose different `ReasoningEffort` values (type is a free-form string) and rate limits. The
   schema-constrained turn proved `effort:"low"` is accepted.
9. **Probe env limits**: daemon mode and `proxy` bridging are unverified (§4.7); a review under
   `read-only` returned a sandbox-blocked message in this environment (§1) but the protocol flow
   (request → notifications → `exitedReviewMode` → `turn/completed`) is proven.
10. `emittedAtMs` and other additive envelope/response fields are safe for the current JS client (it
    ignores unknown keys), but the generated TypeScript types will surface them once refreshed.

---

## 9. Reproducing / probe inventory

All probes are dependency-free Node ESM and live under [`probes/`](../probes/). They create a writable
`CODEX_HOME` at `/tmp/codex-probe-home` (copy of readable `auth.json`, mode 0600) unless
`CODEX_HOME` is already writable; delete it afterwards because it contains live tokens.

| Script | Model calls | What it proves |
| --- | --- | --- |
| `probes/probe-appserver.mjs` | 2 (1 short turn, 1 interrupted turn) | handshake, `thread/start`, `thread/name/set` (ephemeral vs persistent), `turn/start`, notifications, `turn/interrupt`, `thread/resume`, `thread/list`, auth/config/rateLimits, param-shape validation matrix |
| `probes/probe-review.mjs` | 1 review | `review/start` inline on a scratch `/tmp` git repo with an uncommitted bug; captures `entered/exitedReviewMode`, agent message, `turn/completed`, deprecation notices; validates custom/baseBranch/commit targets and `outputSchema` rejection without model calls (`--sandbox danger-full-access` needed only inside this agent sandbox) |
| `probes/probe-threadlist.mjs` | 1 short turn | thread `source`/`threadSource` semantics, `thread/list` filter matrix before/after a persisted turn, persistent `thread/resume`, inline-vs-detached deprecation |
| `probes/probe-output-schema.mjs` | 1 short turn | `turn/start.outputSchema` + `effort` honored (structured JSON final message) |
| `probes/probe-import.mjs` | 0 | `externalAgentConfig/import` accepts the plugin payload (incl. missing `skills`), progress/completed notification shapes; all state confined to the temp `CODEX_HOME` |
| `probes/probe-unix-listen.mjs` | 0 | `--listen unix://` is WebSocket-over-unix JSON-RPC; two concurrent clients; bare `unix://` control-socket path; `proxy`/`daemon` observations |
| `probes/probe-plugin-client.mjs` | 1 short turn | the **unmodified plugin modules** (`codex.mjs`, `app-server.mjs`, `broker-lifecycle.mjs`) end-to-end: broker transport, auth status, persistent thread + name + turn capture, `findLatestTaskThread` drift |
| `probes/lib-probe-home.mjs` | – | temp `CODEX_HOME` helper (copies only `auth.json`; never logs it) |

Type evidence: `probes/app-server-types/` (full `generate-ts` output; inspect
`InitializeParams.ts`, `InitializeCapabilities.ts`, `v2/ThreadStartParams.ts`, `v2/ThreadResumeParams.ts`,
`v2/TurnStartParams.ts`, `v2/ReviewStartParams.ts`, `v2/ReviewTarget.ts`, `v2/ThreadListParams.ts`,
`v2/UserInput.ts`, `v2/AskForApproval.ts`, `v2/SandboxMode.ts`, `v2/SandboxPolicy.ts`,
`v2/ExternalAgentConfigImportParams.ts`, `v2/MigrationDetails.ts`, `v2/Turn.ts`, `v2/Thread.ts`,
`v2/ThreadItem.ts`, `ServerNotification.ts`, `ClientRequest.ts`, `ServerRequest.ts`).
CLI help captures: `probes/cli-help/`.

Commands:

```bash
# Regenerate protocol types (evidence)
codex app-server generate-ts --out probes/app-server-types

# Probes (each writes its own probes/report-*.json)
node probes/probe-appserver.mjs
node probes/probe-review.mjs            # add --sandbox danger-full-access inside an agent sandbox
node probes/probe-threadlist.mjs
node probes/probe-output-schema.mjs
node probes/probe-import.mjs
node probes/probe-unix-listen.mjs
node probes/probe-plugin-client.mjs

# Cleanup (contains the temporary auth.json copy)
rm -rf /tmp/codex-probe-home
```
