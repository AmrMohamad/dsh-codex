# DSH Host-plugin API recon (authoritative answers for this profile)

Scope: everything needed to author, install and verify a **Host-only** DeepSeek Harness
(DSH) Cordis bundle in the Desktop profile without guessing.

Verified on: DSH `0.2.1-rc.2`, Desktop app, profile `desktop`
(`~/.dsh/profiles/desktop`), Node in the shell `v26.12.0`,
workspace `~/Developer/codex-deepseek-plugin`.

**Where the truth came from.** The installed app is packed in
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` and its package
directories live under
`.../app.asar/dsh/node_modules/@deepseek-ai/<pkg>/`. In this installation the
`lib/types/**/*.d.ts` files are **not shipped** (reads of e.g.
`dsh-tools/lib/types/index.d.ts` fail), so exact API contracts were read from
(a) `cordis_inspect_query` Host `Service` contracts, which are generated from the
installed packages and are authoritative, (b) the shipped `lib/*.js` runtime,
(c) shipped `README.md` files. Citations use:

* `$PKG` = `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai`
* `$SKILL` = `$PKG/dsh-agent-preset/skills/cordis-plugin-development`
* `$DSH` = `.../app.asar/dsh` (the installation root; `$DSH/package.json:4` = `0.2.1-rc.2`)

Paths are shown package-relative after the first use so they stay readable.

---

## 0. Environment facts (measured)

| Fact | Value |
|---|---|
| DSH runtime version (`getDshRuntimeVersion()`) | `0.2.1-rc.2` (`$DSH/package.json:4`; read from `$PKG/dsh-app-boot/package.json:5`, code `app-boot/lib/index.js:271-275`) |
| Cordis version | `4.0.5` (`$DSH/package.json:7`) |
| schemastery (Config DSL) | `3.18.5` (`$DSH/package.json:310`) |
| Profile dir | `~/.dsh/profiles/desktop` — `package.json`, `cordis.patch.yml`, `cordis.yml`, `pnpm-workspace.yaml`; **no `node_modules` today** |
| Profile bundles (ordered) | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-experimental-agent-team-profile`, `@deepseek-ai/dsh-experimental-inspector-profile` (profile `package.json`) |
| `autoInstallPeers` | `false`; `nodeLinker: hoisted` (profile `pnpm-workspace.yaml`; template at `app-boot/lib/index.js:598-603`) |
| HMR | live (`cordis_inspect_query` Host `Service` → `hmr` is mounted with `reconcileProfile`) |
| Shell env seen by agent shells | `DSH_HOME=~/.dsh`, `DSH_PROFILE=desktop`, `DSH_PROFILE_DIR=~/.dsh/profiles/desktop`, `DSH_SESSION_ID=<session>`, `DSH_WEB_URL=http://127.0.0.1:49845` |
| Project skill roots | `<projectRoot>/.dsh/skills` and `<projectRoot>/.agents/skills`; the workspace has **no** `.git` at its root, nearest `.git` is `/Users/.../codex-plugin-cc/.git`, user roots are `~/.dsh/skills` (absent) and `~/.agents/skills` (exists) (`$PKG/dsh-skill-filesystem/README.md:44-56`) |

Probes run (read-only):

* `node -e "import('@deepseek-ai/dsh-tools')"` from the workspace fails:
  `ERR_MODULE_NOT_FOUND … imported from ~/Developer/codex-deepseek-plugin/[eval]`.
  `module.paths` = workspace/node_modules, ~/Developer/node_modules, ~/node_modules, … — the
  workspace has no DSH packages. (Consequence for testing in §13.)
* A plain object shaped like a raw tool definition is valid JS with no imports (§4.1).

---

## 1. Minimal Host-only bundle layout and manifest

A bundle is a package whose `package.json` declares `dsh.bundle.patch`; the patch
file inserts Loader rows (`$SKILL/references/host-plugin.md:5-27`,
`app-boot/lib/index.js:517-531` for patch-file validation). **A Host-only bundle
needs no dependencies, install scripts, or build step** (`host-plugin.md:7`).

Recommended layout (all files at the package root; `linkedRoot` = this directory):

```
dsh-codex/                      # package dir (absolute target for install)
├── package.json
├── cordis.patch.yml
├── index.js                    # ESM; export function apply(ctx, config)
├── locale/en.json              # display metadata (required for a visible inventory entry)
├── icon.svg                    # original/licensed icon (SVG|PNG|JPEG|WebP ≤ 256 KiB)
└── skills/*.md                 # optional, only if you ship file-based skills (§12.2)
```

`package.json` (minimum, zero-import variant — see §4/§11):

```json
{
  "name": "@local/dsh-codex",
  "version": "0.1.0",
  "private": true,
  "description": "OpenAI Codex CLI capabilities as DSH tools and slash commands.",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "skills/*.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Rules that matter (all verified):

* `dsh.bundle.patch` is one path or an ordered list of paths; anything else fails
  bundle validation (`app-boot/lib/index.js:517-531`).
* The Loader imports the plugin by **package specifier**, so `exports["."]` (or
  `main`) must point at the ESM entry.
* Display metadata is read **without activating** the plugin: `locale/en.json`
  `meta.title` + `meta.description`, resolved through Node exports as
  `<pkg>/locale/en.json`, so `exports` must expose it. Missing fields fall back
  to package `name`/`description`; malformed metadata keeps valid text plus a
  diagnostic (`host-plugin.md:29-55`; reader `$PKG/dsh-app-boot/lib/index.js:2168-2247`).
* Icon: package-root `icon` field in `package.json` takes priority, else the
  exported `<pkg>/icon`; SVG/PNG/JPEG/WebP ≤ 256 KiB, must stay inside the
  package dir (`host-plugin.md:44-51`; validation `app-boot/lib/index.js:2077-2119`).
* `files` filters a packed/published bundle only. **A linked local directory is
  not filtered by `files`** — check files directly (`host-plugin.md:35`).
* A Host-only bundle still needs this metadata because it gets a visible
  inventory entry (`host-plugin.md:55`).

`cordis.patch.yml` — insert shape (`host-plugin.md:20-27`):

```yaml
- insert:
    - id: dsh-codex
      name: '@local/dsh-codex'   # MUST equal package.json "name"
      config: {}
```

The row id must be unique across the whole composition; the bundle patch is a
normal Loader patch layer applied in `dsh.profile.bundles` order. Inserting at
the top level (no `group`) mounts the plugin in the **global** scope, so every
tool/command/prompt/skill it registers is global to the profile.

Host export forms (`host-plugin.md:57-64`):

```js
export function apply(ctx, config) { /* register everything here */ }
export const inject = ['tools', 'commands', 'systemPrompt', 'workingDirectory'] // optional
export const Config = z.object({ /* optional, see §11.1 */ })
export const name = 'dsh-codex' // optional diagnostic name (shipped packages export it, e.g. tool-jobs:418)
```

Do not mix `apply` with a default-exported service class.

---

## 2. Install path: what `plugin_manager install_bundle` does to a local directory

The Lead runs this action (never shell). For an **absolute local directory**
target:

1. `installBundle(spec)` validates the spec; an absolute path is an accepted
   spec (`$PKG/dsh-plugin-manager/lib/types/tools.js:11`), and
   `inspect()` reads the target's `package.json`, refusing non-packages and
   packages with no `dsh.bundle` (`plugin-manager/lib/index.js:1855-1868`).
2. It runs `pnpm add <spec>` **in the profile directory**
   (`plugin-manager/lib/index.js:2020-2038`) — for a local directory pnpm records
   a `link:` dependency and materializes `profile/node_modules/@local/dsh-codex`
   as a symlink to the workspace package dir (`plugin-manager/README.md:44`,
   `:50`; app-boot consumes exactly those symlinks as *linked roots*,
   `app-boot/lib/index.js:664-692`).
3. It re-reads the profile manifest, finds the one changed dependency, resolves
   the bundle dir (installation first, then profile, `app-boot/lib/index.js:995-1000`),
   requires `dsh.bundle`, evaluates the **DSH version compatibility** rule, and
   parses every declared patch file (`plugin-manager/lib/index.js:2063-2079`).
   If the package declares `engines.dsh` / `peerDependencies` on
   `@deepseek-ai/dsh-*` that do not satisfy `0.2.1-rc.2`, the install is refused
   as `incompatible-version` (`app-boot/lib/index.js:279-326`;
   `plugin-manager/README.md:69-75`).
4. It appends the package name to `dsh.profile.bundles`
   (`plugin-manager/lib/index.js:2280-2306`; appended at the **end**, README:40)
   and reloads the composed profile through HMR
   (`plugin-manager/lib/index.js:2084-2095`, `:2351-2372`).

**Install result fields to read** (union of `change()` and `installBundle()`):

| field | meaning |
|---|---|
| `application` | `applied` \| `cancelled` \| `overridden` \| `restart-required` \| `failed` (`plugin-manager/lib/index.js:2373-2401`; `lib/types/tools.js:46-67`) |
| `warnings` | diagnostics about unchanged pre-existing inactive entries; not a failure of install |
| `nextStep` | present only when not plainly applied; tells you what to do/tell the user (`tools.js:46-67`) |
| `bundle`, `version`, `target`, `stage`, `enabled`, `changed` | installed package identity / saved-state change (`index.js:2084-2095`, `:2377-2384`) |
| `packageResult` | pnpm run facts: `kind`, `exitCode`, `output`, `timedOut` (`index.js:2039`, `:2244-2250`) |
| `failedAt` | `spec-host` \| `registry` \| other when package fetch failed (`index.js:2015-2018`, `:2045-2049`) |
| `pendingBuilds` | install-script approval names when pnpm blocked scripts (`index.js:2055-2061`; README:64, :65) |
| `approvedBuilds`, `registries` | echoed request / registries asked |
| `restartReason` | only with `restart-required`: `no-hmr`, `package-moved`, `host-module`, `unmanaged-plugin`, `module-comparison` (`index.js:2366-2371`; `tools.js:34-40`) |
| `error.code` | refusal code (`already-installed`, `not-bundle`, `incompatible-version`, …) (`index.js:2392-2394`; `tools.js:7-21`) |

With HMR mounted (true here), a fresh bundle normally applies immediately
(`application: "applied"`). **Replacing** an already-loaded package's code needs a
restart for a fresh module generation (`$SKILL/references/host-plugin.md:70`;
`plugin-manager/README.md:141`). Every `plugin_manager` action needs
`danger-full-access` or approval; approval does not change session mode
(`plugin-manager/README.md:31`; tool description). Desktop package operations
remain owned by the Desktop shell (`plugin-manager/README.md:146`).

---

## 3. Import resolution verdict (the critical question)

**Q: Can an installed bundle `import { defineTool } from '@deepseek-ai/dsh-tools'` at runtime?**

**YES — but only if the bundle's `package.json` declares each imported
`@deepseek-ai/*` package in `peerDependencies`.** Bare imports that are not in
`node:*`/builtins and not declared as peers **fail with `ERR_MODULE_NOT_FOUND`**,
because a linked local package has no physical `node_modules`.

Mechanism (all in `$PKG/dsh-app-boot/lib/index.js`):

1. The launcher computes one immutable *runtime resolution* per profile:
   installation package table + profile bundle dependency closures + **linked
   roots** (`app-boot/lib/index.js:766-799`; README:67).
2. `linkedProfileRoots()` treats every symlink under
   `<profileDir>/node_modules` whose real target is outside the profiles tree as
   a linked root (`app-boot/lib/index.js:664-692`). A `link:` installed package
   is exactly that, so the workspace package dir becomes a linked root.
3. The runtime resolution is installed as an interception on Node's internal ESM
   and CJS resolvers (`app-boot/lib/index.js:1846-2058`; README:67, :133).
   Importers inside a linked root are routed through `routeLinked()`
   (`app-boot/lib/index.js:1676-1730`).
4. `routeLinked()` resolves a bare name only when, at some ancestor directory
   `D` of the importing file, `readPeerNames(D)` (i.e. **`D/package.json`'s
   `peerDependencies` keys**, `app-boot/lib/index.js:1346-1354`) contains that
   name and the name exists in the runtime table. It then routes to the
   installation-provided package (`app-boot/lib/index.js:1676-1697`).
   Otherwise it falls back to a physical `node_modules` candidate, then to
   native Node resolution — which fails for the workspace package.
5. Importers inside the **active profile directory** get the same runtime-table
   routing for all package names (`routeScoped`, `app-boot/lib/index.js:1613-1675`,
   esp. :1664-1671), so a `file:`-copied install would work without peers — but
   the documented local-directory install is a `link:` (linked layer), so **write
   the peers**.

Therefore:

```jsonc
"peerDependencies": {
  "@deepseek-ai/cordis": "~4.0.5",
  "@deepseek-ai/dsh-tools": "0.2.1-rc.2",
  "@deepseek-ai/schemastery": "~3.18.5"
}
```

* Use exactly the running version for every `@deepseek-ai/dsh-*` peer
  (`0.2.1-rc.2`); ranges are checked against the runtime with
  `includePrerelease` (`app-boot/lib/index.js:276-298`). A wrong range makes the
  bundle **skipped at composition/load** (`loadProfileDirectory`,
  `app-boot/lib/index.js:1025-1027`) and the install refused
  (`plugin-manager/lib/index.js:2075-2076`). Declaring `engines.dsh` instead
  bypasses that check, but peers are still required for resolution.
* `autoInstallPeers: false` in this profile means pnpm does not fetch/install
  peers; it only uses them to resolve at runtime. Missing peers physically is
  expected and harmless.
* `node:*` builtins always resolve unchanged (bare-package classifier skips
  builtins: `app-boot/lib/index.js:1276-1283`).
* `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are *not* `dsh-*`, so they
  are exempt from the version compatibility check, but still need a peer entry
  to resolve.

**Lowest-risk alternative:** author `index.js` with **zero bare imports** and
register raw `ToolDefinition` objects (§4.1). Then no peers, no compatibility
check, no import-resolution risk. The rest of this doc gives both variants.

> `dsh-analyst` observed a teammate's `_scratch/runtime-probe` and `probes/`
> directories; nothing in this doc depends on them.

---

## 4. Tool registration API

### 4.1 Raw `ToolDefinition` object accepted by `ctx.tools.register()` (no import needed)

`ToolDefinition` = `ToolSchema` (`name`, `description`, `parameters`,
optional `deferLoading`) **plus** a required `output` and `execute`
(cordis_inspect_query Host `Service` → `tools`; runtime validation
`$PKG/dsh-tools/lib/index.js:2974-2983`).

Verified shape (this object registers and executes; the registry validates it at
registration and validates each return value against `output.schema`):

```js
const codexExecTool = {
  name: 'codex_exec',
  description:
    'Run one non-interactive OpenAI Codex CLI task in the session working directory and return its final message.',
  // Model-facing parameters: ordinary JSON Schema (ToolSchema.parameters: Record<string, unknown>)
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Task for Codex.' },
      cwd: { type: 'string', description: 'Working directory; defaults to the session directory.' },
      model: { type: 'string', description: 'Optional Codex model id.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  output: {
    // Enforced output schema: the *raw* JSON Schema subset, not the author DSL.
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        exitCode: { type: 'integer' },
      },
      required: ['text', 'exitCode'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    // args is the parsed JSON arguments; exec is ToolRunContext (see §4.3)
    return { text: 'hello', exitCode: 0 }; // MUST satisfy output.schema
  },
};
```

What `register()` validates (`dsh-tools/lib/index.js:2974-2983`):

* `output` must be an object with a `render` function; `presentationMeta` if
  present must be a function.
* `output.schema` must be inside the enforced JSON-Schema subset
  (`dsh-tools/lib/index.js:8-30`: any JSON root, one scalar `type`, object
  `properties`/`required`/boolean `additionalProperties`, array `items`, scalar
  `enum`/`const`, exactly-one `oneOf`; unsupported keywords reject).
  `parameters` and `description` are **not** validated in the raw path.
* `timeoutMs` if present must be a positive finite number. It is declarative
  only — the registry does not enforce it (`dsh-tools/README.md:235`); enforcing
  needs `@deepseek-ai/dsh-tool-call-timeout-policy`.
* `name` must not be `run_code` (reserved), and must be unique within the layer
  (`dsh-tools/lib/index.js:2981-2982`; duplicates throw from the scoped layer).
* Registration returns the disposer; it is owned by the calling context, so it
  is removed when the plugin unloads (§11.3).

`output.render(args, value)` returns `ContentBlock[]`; a text block is
`{ type: 'text', text }` (same shape the registry itself uses for errors,
`dsh-tools/lib/index.js:3343-3346`). `value` is the deep-frozen, validated return
value (`dsh-tools/lib/index.js:3636-3667`). `presentationMeta?` may return JSON
stored as result `meta`.

### 4.2 `defineTool()` variant (requires peers from §3)

`defineTool` compiles the author parameter DSL to JSON Schema, validates model
arguments before the body, and derives the output schema
(`$PKG/dsh-tools/lib/index.js:838-887`). Signature and example:

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

ctx.tools.register(defineTool({
  name: 'codex_exec',
  description: '…',
  parameters: {
    prompt: { type: 'string', required: true, description: 'Task for Codex.' },
    cwd: { type: 'string' },
    model: { type: 'string' },
  },
  output: {
    schema: {                        // author DSL is accepted here
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true }, exitCode: { type: 'integer', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) { return { text: '…', exitCode: 0 }; },
}));
```

Author-DSL details: `required: true` must be exactly `true` when present
(`dsh-tools/lib/index.js:603-604`); allowed node types are
`string|number|integer|boolean|null|array|object|json|oneOf` (:687-751);
`object` requires an explicit boolean `additionalProperties` (:699-702);
`parameters` compiles to an `{type:'object', properties, required?}` schema
(:802-811). `timeoutMs` must be positive finite (:847). Model-facing README usage
matches (`$PKG/dsh-tools/README.md:38-64`).

### 4.3 `execute(args, exec)` and the `exec` object (session/cwd/signal)

`ToolRunContext extends ToolExecution` (cordis_inspect_query tools contract;
pipeline `dsh-tools/lib/index.js:3390-3415`, `:3636-3667`):

```ts
interface ToolExecutionInput {
  callId: ToolCallId; rootCallId?: ToolCallId; name: string;
  schema?: ToolSchema; arguments: unknown;
  agent?: Agent; parent?: ToolExecutionToken; signal: AbortSignal;
}
interface ToolExecution extends ToolExecutionInput { rootCallId: ToolCallId; token: ToolExecutionToken; }
interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void;  // extra model-facing context for the next step
  concludeTurn(): void;                      // make this call end the turn after it runs
}
```

Practical access from a tool body:

| need | how | citation |
|---|---|---|
| calling agent | `exec.agent` (may be `undefined` for non-agent calls — guard) | inspection `ToolExecutionInput.agent?` |
| session id | `exec.agent.id` (the `Agent.id` **is** the `SessionId`, inspection `Agent` type / `SessionId`) or `exec.agent.session.id` | inspection; shipped code reads `exec.agent.session` (`dsh-tools/lib/index.js:2883-2892`, `plugin-manager/lib/types/tools.js:93`) |
| session object | `exec.agent.session` (live `dsh-agent` Agent also exposes `.ctx`; `$PKG/dsh-agent/README.md:63`) | as above |
| cwd (committed, no I/O) | `ctx.workingDirectory.get(exec.agent.session)` | inspection `workingDirectory.get(session: Session): string` |
| cwd (validated/restored, async) | `await ctx.workingDirectory.ensure(exec.agent, exec.signal)`; fallback `ctx.workingDirectory.defaultDirectory` | inspection; shipped use `dsh-tools/lib/index.js:2883-2886` |
| cancellation | `exec.signal` (caller-owned; registry fuses wrapper signals) | inspection; README `dsh-tools/README.md:126` |
| call identity for job lifecycle | `exec.callId`, `exec.rootCallId` | inspection; `JobToolCall` |
| parsed args | first parameter (`args`); also `exec.arguments` | `dsh-tools/lib/index.js:3406-3407` |
| additional context / turn conclusion | `exec.deferContext(msg)`, `exec.concludeTurn()` | inspection |

Error handling: throw for ordinary failure; the pipeline materializes
`Error: <message>` content and an error result without ending the turn
(`dsh-tools/README.md:126`, `:215`; `dsh-tools/lib/index.js:3712-3726`).
`execute` must honor `exec.signal`; cancellation of a started body drains before
it becomes `ABORTED` (`dsh-tools/lib/index.js:3390-3414`).

Optional `ToolDefinition` members (all optional): `finalizeContent(exec, result) =>
ContentBlock[] | undefined` (last content transform), `projectContent(exec, result)`
(earlier transform), `isConcurrencySafe(args)`, `presentCall/presentResult` (Host
presentation descriptors; the built-in Web Client does **not** consume them —
`dsh-tools/README.md:95`), `deferLoading: true`.

---

## 5. Commands: `ctx.commands.register()`

Service contract (cordis_inspect_query `commands`; README
`$PKG/dsh-commands/README.md:30-66`):

```ts
interface CommandDefinition {
  readonly definitionId?: CommandDefinitionId;
  readonly name: string;                 // lowercase; duplicate in one scope throws
  readonly description: string;
  readonly input?: { hint: string; attachments?: boolean };
  readonly recordInput?: boolean;        // default true; false when a domain event already records it
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}
interface CommandInvocation {
  readonly commandId: CommandId;
  readonly agent: Agent;                 // exact receiving agent
  readonly rawInput: string;             // everything after "/name"
  readonly attachments: readonly (ImageBlock | FileBlock)[];
  readonly signal: AbortSignal;
}
type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: SessionSeq }
  | { readonly kind: 'error';   readonly text: string };
```

Example (shape taken from README:34-44):

```js
ctx.commands.register({
  name: 'codex',
  description: 'Run an OpenAI Codex task in this session.',
  input: { hint: '<prompt>' },
  async handler({ agent, rawInput, signal }) {
    // runs directly against the agent; no model message is created
    return { kind: 'success', text: `codex prompt queued: ${rawInput}` };
  },
});
```

Behavior facts: a plain-context registration is **global**; registering the same
name twice in one layer throws; typed names are lowercase `[a-z0-9_-]`;
`command/run` + `command/done` are appended to the receiving agent's session log
(log-only, no turn); a thrown/aborted handler settles `kind:'error'`; UI output
does not become model tokens (`dsh-commands/README.md:46-68`, `:86-96`, `:117-129`).
The adapter surfaces commands in the Web composer/slash UI. This service is
mounted in the profile (the inspection contract resolves; the composition carries
an `include:commands` row for `@deepseek-ai/dsh-commands`).

---

## 6. System prompt: `ctx.systemPrompt.section()` / `.context()`

`PromptSection` / `PromptContext` (cordis_inspect_query `systemPrompt`):

```ts
interface PromptSection {
  readonly name: string;
  readonly order: number;                                        // finite; throws otherwise
  readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?: boolean;                                // false = keep literal {{…}}
  readonly complete?: boolean;                                   // at most one active; replaces all sections
}
interface PromptContext {
  readonly name: string; readonly order: number;
  readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?: boolean; readonly required?: boolean;
}
```

Registration rules (`$PKG/dsh-system-prompt/lib/index.js`): registration happens
in the calling context's scope; a scoped section shadows a global section with the
same name; duplicates within one layer throw (`:203-205`, `:253-256`);
`order` must be finite or a `TypeError` is thrown (`:254`); sections are sorted by
`order` then name (`:100-103`, `:380-397`); at most one `complete: true` section
may be active (`:381-382`). Registration/disposal emit `system-prompt/change`
(`:245-256`).

Ordering constants live in `SECTION_ORDERS` (`dsh-system-prompt/lib/index.js:10-43`):

```
HARNESS_IDENTITY -1000, DEPLOYMENT_PERSONA_PREFIX 0, PLAN_POLICY 500,
TEAM_POLICY 600, PTC_ONLY 800, FILE_REFERENCE 900, TOOL_BASH 1000, TOOL_PWSH 1010,
TOOL_READ 1100, TOOL_WRITE 1200, TOOL_EDIT 1300, TOOL_GLOB 1400, TOOL_GREP 1500,
TOOL_JOBS 1600, TOOL_PTY 1700, TOOL_WEB_SEARCH 2000, TOOL_WEB_FETCH 2100,
TOOL_LSP 2200, TOOL_SESSION_QUERY 2300, TOOL_GOAL 2400, TOOL_WORKFLOW 2600,
TOOL_RALPH 2700, TOOL_SUBAGENT 2800, TOOL_REPORT 2900, TOOL_COMPUTER_USE 3000,
MCP_SERVERS 3100, TOOLS_SDK 5000, DELIVERABLE_FILE_REFERENCES 9000,
STRUCTURED_OUTPUT 9900, HARNESS_SOURCE 10000, WEB_SURFACE 10100,
DEPLOYMENT_PERSONA_SUFFIX 10200
```

`CONTEXT_ORDERS` (for `ctx.systemPrompt.context()`): `WORKING_DIRECTORY 100`,
`SANDBOX_POLICY 110`, `APPROVAL_POLICY 115`, `SUBAGENT_DELEGATION 120`,
`TEAM_IDENTITY 125`, `HARNESS_SOURCE 200`, `WEB_SURFACE 210`
(`dsh-system-prompt/lib/index.js:44-52`).

`getSectionOrder(name)` / `getContextOrder(name)` return those numbers
(`:262-272`). For a plugin-owned section pick a finite literal in an unused gap —
e.g. `2500` places Codex guidance just before `TOOL_WORKFLOW`:

```js
ctx.systemPrompt.section({
  name: 'codex:guidance',
  order: 2500,
  text: [
    'Use the codex_* tools to delegate non-interactive coding/review tasks to the OpenAI Codex CLI.',
    'Prefer codex_exec for one-shot tasks; it inherits the session working directory unless cwd is given.',
  ].join('\n'),
});
```

`text` may be a function `(assembleContext) => string` for live text.
`interpolate: false` keeps literal `{{...}}`. Do not use
`ctx.on('system-prompt/assemble')` to add text (`$SKILL/references/practices.md:17`).

---

## 7. Background jobs: `ctx.jobs.start()` (exact runtime semantics)

Service is mounted (`@deepseek-ai/dsh-jobs-local` implements it; inspection
contract `jobs`; `Config.listConfigs` entry `include:jobs` →
`@deepseek-ai/dsh-jobs-local`). Types (inspection `jobs`):

```ts
interface JobSpec {
  kind: JobKind;                       // typed as 'bash' only (JobKindMap { bash: 'bash' })
  label: string;
  owner?: SessionId;
  toolCall?: { callId: ToolCallId; rootCallId: ToolCallId };
  outputLimitBytes?: number;           // positive safe integer
  output?: readonly JobOutputSource[]; // pull sources pumped by the registry
  run(job: JobHandle): JobHooks;
}
interface JobHandle {
  readonly id: JobId;
  append(text: string, options?: { channel?: 'stdout'|'stderr'|'log'; gapBefore?: true }): void;
  updateProgress(line: string): void;
}
interface JobHooks {
  cancel(reason?: string): void;
  done: Promise<JobOutcome>;           // { status:'completed'|'killed'|'failed', detail?, result? }
}
interface JobOutputSource {
  channel?: 'stdout'|'stderr'|'log';
  read(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string };
}
```

### 7.1 Is a custom `kind` accepted at runtime? — **YES**

`LocalJobRegistry.start()` validates only that `spec.kind` is a **non-empty
string** — it does **not** restrict to `'bash'`
(`$PKG/dsh-jobs-local/lib/index.js:412-419`):

```js
start(spec) {
  const owner = this.resolveOwner(spec.owner);
  if (!this.servesOwner(owner)) throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)');
  if (spec.kind.length === 0) throw new Error('invalid job kind: expected a non-empty string');
  if (spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string');
  if (spec.outputLimitBytes !== undefined && (!Number.isSafeInteger(...) || <= 0)) throw ...
  ...
}
```

The id becomes `` `${spec.kind}-${uuid16}` `` (`:420-423`), e.g.
`codex-0123456789abcdef`, and `JobView.kind` is `string`. The **type-only**
restriction (`JobKindMap` has only `bash`) is irrelevant in plain JS; in TS it
would need a cast. Shipped tools are kind-independent
(`$PKG/dsh-tool-jobs/README.md:77-79`).

Other preflight facts (`dsh-jobs-local/lib/index.js:412-419`, `:432-500`):
`owner` is resolved to a **live** `Agent` via `ctx.agents.get(session)` — an
unknown session throws (`:537-543`); a controller must serve that owner or
`start()` throws (`:553-556`, `:413-414`) — loading `dsh-tool-jobs` attaches that
controller (`:256`); capacity is `maxConcurrentJobsPerOwner` (default 10,
`:356-362`, `:419`); the producer `run(handle)` is invoked synchronously inside
`start()` and must return hooks; a rejection or throw in `start` leaves no job
registered.

### 7.2 Output: pull sources vs push, and streaming child stdout

* **Pull source**: name `output: [{ channel:'stdout', read(fromByte){…} }]`; the
  registry pumps every spec'd source on a timer (`pumpPollMs` default 150 ms) and
  does one final drain before settlement (`dsh-jobs-local/lib/index.js:489-500`,
  pump implementation `:120-161`). A lossy read becomes a gap chunk; `spillPath`
  is advertised on `JobView.output.spillPaths`.
* **Push**: `job.append(text, { channel })` from the producer (a `node:child_process`
  `'data'` listener is the straightforward way to stream child stdout/stderr).
  Appends after settlement are dropped with a warning (`:697-705`).
* The registry keeps **one bounded ring per job** (`retainBytes` 256 KiB live,
  `settledRetainBytes` 16 KiB after settlement; `:340-346`, README
  `dsh-jobs-local/README.md:42-47`). Model reads consume via `job_output`; other
  readers use non-consuming `readAt`.
* Model-facing controls only exist if `@deepseek-ai/dsh-tool-jobs` is mounted
  (it is in this profile's agent compositions; the `job_output`/`job_list`/
  `job_kill` tools are visible through `cordis_inspect_query Tool listTools`).

Example producer (Codex CLI child):

```js
const id = ctx.jobs.start({
  kind: 'codex',                          // custom kind accepted at runtime
  label: 'codex exec: ' + prompt.slice(0, 60),
  owner: exec.agent?.id,                  // SessionId of the calling session
  toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
  outputLimitBytes: 262144,
  run(job) {
    const child = spawn('codex', ['exec', '--json', prompt], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => job.append(b.toString(), { channel: 'stdout' }));
    child.stderr.on('data', (b) => job.append(b.toString(), { channel: 'stderr' }));
    job.updateProgress('running');
    return {
      cancel: (reason) => child.kill('SIGTERM'),
      done: new Promise((resolve) => child.on('close', (code, signal) => resolve({
        status: code === 0 ? 'completed' : 'failed',
        detail: signal ? `signal ${signal}` : `exit ${code}`,
      }))),
    };
  },
});
return { jobId: id };
```

### 7.3 Kill and settlement semantics

* `kill()` calls the producer's `cancel(reason)` **first**, marks the job
  `stopping`, then returns `'requested'`; a terminal job returns
  `'already-finished'`. The job only settles once `done` resolves; a cancel that
  never settles `done` stalls teardown (`dsh-jobs-local/lib/index.js:644-655`;
  `dsh-jobs/README.md:34`; `dsh-jobs-local/README.md:67`).
* Settlement is first-wins; the `settled` event carries `cause`
  (`producer` | `kill` | `teardown`) and `awaited` (whether a live `wait` was
  released). `job_output` waits therefore suppress completion notices
  (`dsh-jobs-local/lib/index.js:769-796`).
* Jobs outlive producer/controller fibers; owner disposal or service disposal
  cancels them and awaits settlement (`:402`, `:804-839`). A job started owned by
  the calling session dies with that session (`dsh-jobs-local/README.md:55-57`).
* Owner fencing: ids are predictable, access is authorized by owner session id
  (`:564-577`); `list/get/read/kill/wait/remove` take the caller `SessionId`
  (tool code passes `exec.agent?.id`, as `job_output` does at
  `$PKG/dsh-tool-jobs/lib/index.js:342-343`).

### 7.4 Completion notices: do tool-owned jobs notify the calling session?

**Yes, if `@deepseek-ai/dsh-tool-jobs` is mounted in that agent's composition**
(loading it is also what makes `ctx.jobs.start()` legal — it attaches the job
controller). Recipient resolution in `$PKG/dsh-tool-jobs/lib/index.js:263-296`:

```js
ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
  if (event.type === 'removed') { killedByModel.delete(event.job.id); return; }
  if (event.type !== 'settled') return;
  if (killedByModel.delete(event.job.id) || event.awaited
      || event.cause === 'teardown' || event.job.owner === undefined) return;
  const owner = ctx.get('agents')?.get(event.job.owner);   // live agent of the owner session
  if (owner === undefined) return;
  const message = createUserMessage({ content: [{ type:'text', text: fitCompletionNotice(event.job) }],
    source: { kind: 'tool-jobs', form: 'notice', summary: completionSummary(event.job) } });
  if (delivery === 'wakeup' && owner.status === 'idle') owner.followup(message);
  else owner.inject(message);                              // busy owner: next step inbox
});
```

So a job whose `owner` is the tool call's session notifies that session's agent
unless the model already collected it (`awaited`), the model killed it through
`job_kill`, it settled by teardown, or it is unowned. Notice text:
`background job <id> (<kind>: <label>) finished [status: …]. Read its output with job_output.`
(`dsh-tool-jobs/README.md:38-42`; 30 s default wait, 600 s cap, wakeup vs quiet
config at `:53-58`; plugin code `Config` at `dsh-tool-jobs/lib/index.js:88-93`).
If `tool-jobs` is absent from a composition, `ctx.jobs.start()` throws with a
message saying to load it (`dsh-jobs-local/lib/index.js:413-414`) — in this
profile it is mounted for normal agents (verified via `Tool listTools`).

---

## 8. Working directory, agent and session identity

* `ctx.workingDirectory` (inspection; mounted, `dsh-working-directory`):
  * `defaultDirectory: string` — deployment fallback.
  * `get(session: Session): string` — committed directory, **no filesystem I/O**.
  * `ensure(agent: Agent, signal?): Promise<string>` — validates/restores the
    original project when it disappeared.
  * `set(agent, path, signal?)` — change the session directory.
* From a tool: `exec.agent` is the live Agent; `exec.agent.session` is its
  Session; `exec.agent.id` is the `SessionId`. Shipped code does exactly this
  (`dsh-tools/lib/index.js:2883-2892`, `plugin-manager/lib/types/tools.js:93`).
* `ctx.agents.currentInitiator(): Agent | undefined` returns the Agent carrying
  the current process-local async driver chain; `requireInitiator()` throws
  outside one; `withInitiator()/withoutInitiator()` set/clear the boundary.
  It is attribution only, **not authorization** — the explicit
  `exec.agent`/owner fields stay authoritative
  (`$PKG/dsh-agent/README.md:81-113`; inspection `agents` contract).
* In a tool body, prefer `exec.agent` over `currentInitiator()`; use the
  initiator for logging/metrics in helpers that don't receive `exec`.
* Current DSH session id: from the plugin's perspective use
  `exec.agent.id` (=== session id) or `exec.agent.session.id`. `process.env.
  DSH_SESSION_ID` exists in **agent shell** environments (the bash tool injects
  it per session; measured in this session), but it is not a documented Host
  plugin API and may be stale/absent in the Host process — do not use it as the
  session identity source.

---

## 9. Subprocess service and `node:child_process`

`ctx.subprocess` is **mounted** in this profile: `cordis_inspect_query` Host
`Service` returns the `subprocess` contract, and the running config includes the
row `include:subprocess` = `@deepseek-ai/dsh-subprocess-local`.
Spawn contract (inspection; implementation README
`$PKG/dsh-subprocess-local/README.md:10-12`, `:28-68`):

```ts
ctx.subprocess.spawn({
  argv: readonly string[],            // argv[0] absolute path or bare PATH name
  cwd: string,
  stdio: {
    stdin: 'ignore' | 'pipe' | { data: string },
    stdout: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } },
    stderr: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } },
    control?: 'pipe',
  },
  graceMs: number,                    // positive grace for termination
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
}) : SubprocessHandle
```

`SubprocessHandle` = `{ stdin?, stdout?, stderr?, control?, collected: { stdout?,
stderr? }, done: Promise<{ exitCode, signal }>, terminate(): void,
waitForExit(signal?): Promise<boolean> }`. Collected readers are offset-based and
non-consuming: `handle.collected.stdout?.readFrom(fromByte)` returns
`{ text, nextOffset, lossy, spillPath? }` — ideal for `JobOutputSource.read`.
`resolveExecutable(command, env?, signal?)` resolves absolute paths or bare PATH
names in the provider's scrubbed environment; `relative` paths with separators
are rejected. The provider owns signalling and quiescence, and service disposal
terminates/awaits every managed process (`subprocess-local/README.md:64-68`).

Plain `node:child_process` from plugin code: **allowed and it works** — plugin
code is ordinary Node ESM running in-process, so `spawn`/`execFile` import from
`node:child_process` with no peer/resolution concern. Tradeoffs:

| | `ctx.subprocess.spawn` | `node:child_process` |
|---|---|---|
| availability | mounted in this profile (service contract) | always |
| teardown | provider tracks/terminates every managed range on disposal | you own cleanup; must kill on plugin unload/owner disposed or children leak |
| output | bounded collect mode + spill files + offset readers built in | you wire streams yourself (fine for `job.append`) |
| env/PATH | scrubbed PATH via `resolveExecutable`; explicit env | inherits host process env |
| sandbox/approval | **none by itself** | **none** |
| missing runtime | would throw if a composition lacks the provider | none |

**Important:** the DSH sandbox/approval does **not** extend to plugin code or
plugin-spawned processes. Installed Host code "executes in-process outside the
workspace sandbox" (`plugin-manager/README.md:31`). File confinement is applied
by the *shell executors* through `ctx.sandbox.confine()` and the
`ctx.sandboxPolicy` (`$PKG/dsh-bash-sandbox/README.md:28-32`, `:58-60`, `:78-97`),
and approval is a tool-layer flow (`dsh-tools` `tools/pre-execute` → approval
service). A plugin that wants approval or a sandbox must ask those services
explicitly (`ctx.get('approval')`, `ctx.get('sandboxPolicy')`/`ctx.get('sandbox')`).
For a Codex runner this means: child processes spawned with
`ctx.subprocess`/`node:child_process` run with the user's full authority,
regardless of the session file policy — document that in the tool description and
prefer least-privilege argv (no shell string interpolation; pass argv arrays).

---

## 10. Filesystem service (`ctx.fs`, optional)

`ctx.fs` is an abstract provider (inspection): `resolve(path, {cwd, signal}) →
FsTarget`, `readText`, `streamText`, `readBytes(target, signal, maxBytes)`,
`readByteRange`, `listDir`, `stat`, `lstat`, `watch`, `writeText(target, content,
expected?, signal?, sandboxPolicy?)`, `editText(...)`, `processPath(target)`.
`FsTarget = { targetKey, displayPath }`; paths are only meaningful through a
target. Writes take an optional `SandboxExecutionPolicy { mode, workspaceRoot,
sessionId? }` — the bare backend ignores it, a sandboxing backend enforces it.
Treat `ctx.fs` as optional (`ctx.get('fs')` or `ctx.inject(['fs'], …)`): the
plugin can happily use `node:fs` for its own package assets, but session-scoped
reads/writes should prefer `ctx.fs` so a future remote/sandboxed filesystem is
respected.

---

## 11. Config export, `inject`/`effect`, package root, env vars

### 11.1 Config (optional)

If the plugin exports `export const Config = z.object({...})`, the row's
`config` is validated at activation against that schema; defaults are applied
(`host-plugin.md:61-64`; shipped examples: `$PKG/dsh-jobs-local/lib/index.js:356-362`,
`$PKG/dsh-skill/lib/index.js:119-135`, `$PKG/dsh-tool-jobs/lib/index.js:88-93`).
`z` is the default export of `@deepseek-ai/schemastery`
(`import z from '@deepseek-ai/schemastery'`; version `3.18.5` is an installation
dependency, `$DSH/package.json:310`; peer spec pattern `~3.18.5` in
`$PKG/dsh-tools/package.json:56`). If you export `Config`, add
`"@deepseek-ai/schemastery": "~3.18.5"` to `peerDependencies` (§3).

Simplest v1: **no Config export**. Keep tunables as top-level constants and/or
read `config?.field` defensively in `apply(ctx, config)` (Cordis passes the row's
config object; shipped plugins still use `??` defaults, e.g.
`tool-jobs/lib/index.js:223-230`). If you do omit `Config`, the row's `config: {}`
is the whole input and nothing is validated.

### 11.2 `inject` and optional services

* `export const inject = ['tools', 'commands', 'systemPrompt', 'workingDirectory']`
  — hard dependencies; Cordis waits for them and the plugin stays inactive in a
  composition that lacks them (README `@deepseek-ai/cordis/README.md:61-67`;
  `host-plugin.md:61`).
* Optional services: use `ctx.inject([...], (ctx) => { ... })` inside `apply`, or
  guard with `ctx.get('<service>')`. Practices: "Put optional services in inject
  or `ctx.inject([...], ...)` so the plugin stays inactive in profiles without
  them instead of throwing" (`$SKILL/references/practices.md:20`).
* For this profile, `tools`, `commands`, `systemPrompt`, `workingDirectory`,
  `agents`, `skills`, `jobs`, `subprocess`, `fs` are all mounted
  (inspection contracts / Config list). Still design for absence in other
  profiles/presets.

### 11.3 Effects, cleanup, ownership

Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return
its cleanup (`host-plugin.md:64`). Every registration API used here
(`tools.register`, `commands.register`, `systemPrompt.section/context`,
`skills.register/registerProvider`, `jobs.events.subscribe`) already returns the
exact Cordis effect disposer owned by the calling context, so a plugin unload
removes them; you do **not** need to keep/dispose those manually.

For private resources (timers, child processes, watchers), wrap them:

```js
export function apply(ctx) {
  const ac = new AbortController();
  ctx.effect(() => () => ac.abort(), 'dsh-codex: abort in-flight work on unload');
  // composite/generator effects are supported by Cordis and nest teardown order:
  // ctx.effect(function* () { yield disposer; ... }, 'label')
}
```

Shipped references: `ctx.effect(() => () => this.disposeAll(), 'jobs teardown')`
(`dsh-jobs-local/lib/index.js:402`) and `owner.ctx.effect(() => async () => {...})`
(`:804`); `ctx.on(...)` listeners (`dsh-tool-jobs/lib/index.js:231-263`).
Jobs themselves outlive the producer fiber (`dsh-jobs/README.md:128-130`), so if
the plugin unloads while jobs run, kill the ids you own in the effect cleanup
(or rely on owner/service disposal).

### 11.4 Plugin package root at runtime

Use ESM URL resolution — never guess paths from `$DSH_PROFILE_DIR`:

```js
import { fileURLToPath } from 'node:url';
const packageDir = fileURLToPath(new URL('.', import.meta.url));       // linked package dir
const assetUrl = new URL('../assets/skill.md', import.meta.url);      // package-relative asset
```

Shipped patterns: `new URL('../package.json', import.meta.url)` in
`app-boot/lib/index.js:271-275`; `new URL('../assets/…', import.meta.url)` +
`fileURLToPath` in `$PKG/dsh-skill-badge/lib/index.js:11-15`. For a linked
install this resolves to the workspace package dir (the real path), which is what
you want for shipping assets/skills.

### 11.5 `$DSH` environment variables

`DSH_HOME`, `DSH_PROFILE`, `DSH_PROFILE_DIR` are set by the profile launcher and
are readable from plugin code as `process.env.*` (they were present in this
session's shells); `DSH_SESSION_ID` / `DSH_WEB_URL` are session-shell additions.
Rules: package lookups must go through DSH services or `import.meta.url`, **not**
`$DSH_PROFILE_DIR` (bundled packages resolve from the installation, profile
bundles from the profile; skill base dir says never guess the path from
`$DSH_PROFILE_DIR`). Session identity must come from `exec.agent`, not env.

---

## 12. Skills: how a bundle contributes Codex reference skills

Service: `ctx.skills` (mounted; inspection contract; `@deepseek-ai/dsh-skill`
registry with `@deepseek-ai/dsh-skill-filesystem` as the local provider). Two
supported ways to contribute skills from a bundle:

### 12.1 Runtime (embedded) skills — recommended for this plugin

A plugin can register in-memory skills at runtime; the registry fills in the
invocation policy and the reserved `runtime` provider label
(`$PKG/dsh-skill/README.md:48-55`; code `$PKG/dsh-skill/lib/index.js:193-215`):

```js
export function apply(ctx) {
  ctx.inject(['skills'], (ctx) => {
    for (const skill of CODEX_SKILLS) ctx.skills.register(skill);
  });
}

const CODEX_SKILLS = [
  {
    name: 'codex-exec',                          // kebab-case: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ (:17)
    description: 'Delegate a non-interactive coding task to the OpenAI Codex CLI.',
    whenToUse: 'Use when the user asks to run Codex, or when a task should be delegated to Codex.',
    content: '...full markdown instructions...',  // body; validated as string on load (:471-490)
    source: 'runtime',                            // label whatever you like; 'runtime' is natural
    invocation: { modelInvocable: true, userInvocable: true }, // optional; default true/true (:201-208)
    // resourceBase: { kind: 'opaque', description: 'Resources are embedded in the skill text.' },
  },
];
```

Validation at registration: `name` kebab-case, `description` non-empty, invocation
booleans; the provider label defaults to `runtime`; `content` is validated when
the skill is loaded (`dsh-skill/lib/index.js:465-469`, `:471-490`). Same-name
runtime registrations in one layer are first-wins with a warning (`:196-200`).
Registration returns the usual effect disposer (`:209-214`). Model exposure comes
from `@deepseek-ai/dsh-tool-skill` (the `skill` tool + session catalog; visible in
`Tool listTools`); the catalog refreshes on `skills/change`
(`dsh-skill/lib/index.js:402-412`).

This needs **no files and no config**, works for a profile-level bundle, and is
the cleanest way to ship 2–3 Codex reference skills.

### 12.2 File-based skills (alternative)

`@deepseek-ai/dsh-skill-filesystem` discovers:

| rank | source | path |
|---|---|---|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `Config.customSkillDirs` |
| 400 | user-dsh | `<dshHome>/skills` |
| 500 | user-agents | `<agentsHome>/skills` |
| 600 | bundled | `Config.bundledSkillDir` |

Skill format: `<name>/SKILL.md` or `<name>.md` directly under a root; YAML
frontmatter with required `name` + `description`; optional `whenToUse`,
`metadata`, `disable-model-invocation`, `user-invocable`
(`$PKG/dsh-skill-filesystem/README.md:34-56`, config `:58-77`). A bundle can ship
markdown under its package dir, but the provider needs an **absolute path** in
its row config (e.g. patch row `skill-filesystem` or a new provider row with
`includeDefaultRoots: false`, `customSkillDirs: ['<package>/skills']`), which is
awkward to express for a linked package (bundle patch YAML cannot know its own
install dir) — prefer §12.1. Also note discovery is one level deep and nested
`**/SKILL.md` is not discovered (`:147-151`).

Shipped example of the bundled-provider pattern (if you later want a provider
object instead of runtime skills): `$PKG/dsh-skill-badge/lib/index.js:10-51` —
provider object with `list()/get()`, `resourceBase` derived from
`new URL('../assets/', import.meta.url)`, registered via
`ctx.skills.registerProvider(() => provider)` with `inject = ['skills']`.

---

## 13. Testing a Host plugin without installing it

Facts: `import '@deepseek-ai/...'` fails from the workspace (probe §0), so a test
must either (a) exercise the zero-import plugin (recommended v1), or (b) run tests
only in the Host process (not available to us), or (c) stub `defineTool` by
importing the plugin entry **after** a loader hook — overkill.

Recommended strategy (works today, no install):

1. Keep `index.js` free of `@deepseek-ai/*` imports (raw tool definitions).
   All DSH APIs arrive through `ctx`.
2. Test with a fake `ctx` that records registrations and supplies the small
   service surface the plugin uses. Example `test/plugin.test.mjs`:

```js
import assert from 'node:assert/strict';
import { apply } from '../index.js';

const tools = [], commands = [], sections = [], skills = [];
const fakeSkills = { register: (s) => { skills.push(s); return () => {}; } };
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  effect: (fn) => fn(),                       // plugins call ctx.effect(() => cleanup)
  on: () => () => {},
  get: (name) => (name === 'skills' ? fakeSkills : undefined),
  inject: (deps, cb) => cb(fakeCtx),          // run optional-service body synchronously
  tools: { register: (def) => { tools.push(def); return () => {}; } },
  commands: { register: (def) => { commands.push(def); return () => {}; } },
  systemPrompt: {
    section: (s) => { sections.push(s); return () => {}; },
    context: (c) => { sections.push(c); return () => {}; },
    getSectionOrder: () => 1600,
  },
  workingDirectory: { get: () => process.cwd(), defaultDirectory: process.cwd(),
                      ensure: async () => process.cwd() },
  agents: { currentInitiator: () => ({ id: 'probe', session: { id: 'probe' } }) },
};

apply(fakeCtx, {});

const tool = tools.find((t) => t.name === 'codex_exec');
assert.ok(tool, 'codex_exec registered');
assert.equal(tool.parameters.type, 'object');
assert.equal(typeof tool.output.render, 'function');
assert.deepEqual(tool.output.render({}, 'ok'), [{ type: 'text', text: 'ok' }]);

// Execute with a fake ToolRunContext; stub external effects in the plugin via
// injectable "runner" indirection so the test never spawns Codex.
const exec = {
  callId: 'call-1', rootCallId: 'call-1', name: tool.name,
  arguments: { prompt: 'hi' }, agent: { id: 'session-1', session: { id: 'session-1' }, ctx: fakeCtx },
  signal: new AbortController().signal,
  deferContext() {}, concludeTurn() {},
};
const value = await tool.execute({ prompt: 'hi' }, exec);
assert.equal(typeof value.text, 'string');
```

3. To keep the test hermetic, structure `index.js` so subprocess execution is a
   small factory (`runCodex(args, exec)`), which the test can monkey-patch via an
   exported test hook, or detect `process.env.DSH_CODEX_FAKE` to return canned
   output.
4. Also load-check the actual file: `node -e "import('./index.js').then(m =>
   console.log(Object.keys(m)))"` from the package dir (ESM is selected by the
   package's `"type":"module"`). Manifest check: `node -e "console.log(JSON.parse(
   require('node:fs').readFileSync('package.json','utf8')).dsh)"`.
5. Do not add a test that imports `@deepseek-ai/dsh-tools` from the workspace: it
   fails (`ERR_MODULE_NOT_FOUND`) until the bundle is installed and running inside
   the Host.

Definition-level correctness (JSON Schema subset) is enforced by
`ctx.tools.register` at activation; an invalid `output.schema` fails the plugin
row, which appears as an inactive/failed entry in the install result and in
`Config.listConfigs`.

---

## 14. Exact install / verify / restart runbook for the Lead

Do not write the profile's `package.json`, `cordis.patch.yml`, or run pnpm in the
profile; `plugin_manager` performs those steps (skill guidance; system prompt).

1. **Pre-flight (read-only)**
   * Package dir must be absolute and contain `package.json` with `name`,
     `version`, `type:"module"`, `exports["."]`, `dsh.bundle.patch`; patch file
     parses as a top-level YAML array; each inserted row has unique `id` and
     `name` equal to the package name; `locale/en.json` has `meta.title` /
     `meta.description`; icon is SVG/PNG/JPEG/WebP ≤ 256 KiB inside the package.
   * If `index.js` imports any `@deepseek-ai/*`, confirm every such package is in
     `peerDependencies` with `0.2.1-rc.2` for `dsh-*` (or `engines.dsh`).
   * `node -e "import('./index.js')"` from the package dir for a syntax/import
     check; run the fake-ctx test (§13).
2. **Install** — `plugin_manager`, `action: "install_bundle"`, `target:
   "~/Developer/codex-deepseek-plugin/dsh-codex"` (absolute path;
   local directory is an accepted spec, error-step text
   `plugin-manager/lib/types/tools.js:11`). This action requires
   `danger-full-access` or approval; `enabled` defaults to true. Only pass
   `approvedBuilds` after explicit user approval (irrelevant for a build-free
   bundle).
3. **Read the result**
   * `application === "applied"` → live. `"restart-required"` → restart the
     desktop app (`restartReason` says why). `"failed"` → read `error.code`,
     `packageResult.kind`, `pendingBuilds`, `failedAt`, and `nextStep`.
   * `bundle`/`version` should be `@local/dsh-codex`/`0.1.0`; `warnings` about
     unrelated pre-existing inactive entries are not a failure.
4. **Verify without needing approval** (`cordis_inspect_query`):
   * Host `Tool` / `listTools` → the new tool names (`codex_exec`, …) appear in
     the returned tools (these are the tools visible to the requesting agent;
     the tool list in this session shows the same shape).
   * Host `Config` / `listConfigs` with `name: "@local/dsh-codex"` → the plugin
     entry (id, status `schema`/`absent`, `packageDir`). Query the entry id to get
     its projected Config schema.
   * Read `~/.dsh/profiles/desktop/package.json` and check:
     dependency `@local/dsh-codex` is a `link:` (or `file:`) spec, and
     `dsh.profile.bundles` now ends with `@local/dsh-codex`; check
     `node_modules/@local/dsh-codex` is a symlink to the workspace dir.
5. **Exercise the capability** in a normal agent turn: the new tools/commands/
   skills are global to the profile; the next step's tool list includes them;
   `job_output` collects a background job; the `skill` tool loads the embedded
   skills. Do not confuse registration with user-visible success — run something.
6. **Reload/restart policy**
   * Configuration changes (profile patch, bundle patch, config values) hot-apply
     while HMR is mounted (the install result will say `applied`).
   * A **new** bundle applies through HMR. Replacing an already-loaded package's
     JavaScript needs a fresh module generation, i.e. restart DSH
     (`host-plugin.md:70`; `plugin-manager/README.md:141`). HMR `reconcileProfile`
     can replace plugins whose loaded files under the profile **or its linked
     package targets** changed, so a code edit may also be picked up on the next
     reconcile — but restart is the deterministic path after JS changes.
   * To restart Desktop: quit and reopen the app; no separate server is started.

---

## 15. Copy-paste v1 `index.js` skeleton (zero imports, zero peers)

This is the lowest-risk shape verified by this recon: raw definitions, optional
services looked up lazily, no `@deepseek-ai/*` imports.

```js
// index.js — Host-only DSH bundle, ESM, no bare imports.

export const inject = ['tools', 'commands', 'systemPrompt', 'workingDirectory'];

export function apply(ctx, config = {}) {
  // 1) Tools ---------------------------------------------------------------
  // `ctx.*.register/section/...` return effect-owned disposers: unloading the
  // plugin removes the tool/command/section/skill automatically.
  ctx.tools.register({
    name: 'codex_exec',
    description: 'Run one non-interactive OpenAI Codex CLI task and return its final message.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task for Codex.' },
        cwd: { type: 'string', description: 'Working directory; defaults to the session directory.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string' }, exitCode: { type: 'integer' } },
        required: ['text', 'exitCode'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const cwd = args.cwd
        || (exec.agent ? ctx.workingDirectory.get(exec.agent.session) : ctx.workingDirectory.defaultDirectory);
      const subprocess = ctx.get('subprocess');
      const result = subprocess
        ? await runViaSubprocess(subprocess, args.prompt, cwd, exec.signal)
        : await runViaChildProcess(args.prompt, cwd, exec.signal);
      return result;
    },
  });

  // 2) Commands ------------------------------------------------------------
  ctx.commands.register({
    name: 'codex',
    description: 'Run an OpenAI Codex task in this session.',
    input: { hint: '<prompt>' },
    async handler({ agent, rawInput, signal }) {
      return { kind: 'success', text: `Codex request received (${rawInput.length} chars).` };
    },
  });

  // 3) Prompt guidance -----------------------------------------------------
  ctx.systemPrompt.section({
    name: 'codex:guidance',
    order: 2500,
    text: 'Use codex_exec for non-interactive Codex tasks; it runs in the session working directory.',
  });

  // 4) Embedded skills (optional service) ---------------------------------
  ctx.inject(['skills'], (skillsCtx) => {
    skillsCtx.skills.register({
      name: 'codex-exec',
      description: 'Delegate a non-interactive coding task to the OpenAI Codex CLI.',
      content: '...markdown instructions...',
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    });
  });

  // 5) Cleanup is automatic for every registration above. For private resources
  //    (child processes, timers, watchers) add your own effect:
  //    ctx.effect(() => () => { /* stop whatever you started */ });
}

async function runViaChildProcess(prompt, cwd, signal) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['exec', prompt], { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ text: out.trim(), exitCode: code ?? -1 }));
  });
}

async function runViaSubprocess(subprocess, prompt, cwd, signal) {
  const handle = subprocess.spawn({
    argv: ['codex', 'exec', prompt], cwd, signal, graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
  });
  const outcome = await handle.done;
  let offset = 0, text = '';
  const stdout = handle.collected.stdout;
  if (stdout) for (;;) {
    const read = stdout.readFrom(offset);
    text += read.text; offset = read.nextOffset;
    if (read.text.length === 0 || read.lossy) break;
  }
  return { text: text.trim(), exitCode: outcome.exitCode ?? -1 };
}
```

Notes for the Lead: register the background-job variant (§7.2) instead of a
blocking foreground call if Codex runs long; the job must be owned by
`exec.agent.id`, and pass `toolCall: { callId: exec.callId, rootCallId:
exec.rootCallId }` so lifecycle records pair with the tool call. To also get
completion notices, nothing else is needed — `dsh-tool-jobs` already delivers
them to the owning session (verified §7.4); if it is missing, `ctx.jobs.start()`
throws with an actionable message.

---

## 16. Citation index (for spot-checking)

| Topic | Location |
|---|---|
| Bundle manifest / patch / metadata / icon / exports / `files` | `$SKILL/references/host-plugin.md:5-70` |
| Bundle patch-file validation; installation-first bundle resolution | `$PKG/dsh-app-boot/lib/index.js:517-531`, `:995-1000` |
| Compatibility rules (`engines.dsh`, else `dsh-*` peers) | `$PKG/dsh-app-boot/lib/index.js:251-336`; `$PKG/dsh-plugin-manager/README.md:69-75` |
| Runtime resolution, linked roots, profile scope | `$PKG/dsh-app-boot/lib/index.js:664-692`, `:766-799`, `:894-898`; `README.md:67`, `:133-140` |
| **Linked-root peer-aware import resolution** | `$PKG/dsh-app-boot/lib/index.js:1336-1354`, `:1676-1730`, `:1846-2058`; `README.md:133-134` |
| Install flow + result fields + bundle selection | `$PKG/dsh-plugin-manager/lib/index.js:1814-1868`, `:1969-2105`, `:2280-2306`, `:2351-2401`; `lib/types/tools.js:7-67` |
| `defineTool`; registration validation; output validation/render; execution | `$PKG/dsh-tools/lib/index.js:838-887`, `:2974-2983`, `:3636-3667`, `:3390-3415`; `README.md:32-64`, `:126`, `:235` |
| Tool contract types (`ToolDefinition`, `ToolExecution`, `ToolRunContext`) | `cordis_inspect_query` Host `Service` → `tools` (referencedTypes) |
| Commands contract + behavior | `cordis_inspect_query` Host `Service` → `commands`; `$PKG/dsh-commands/README.md:30-66` |
| Prompt sections/contexts + order constants | `$PKG/dsh-system-prompt/lib/index.js:10-52`, `:203-205`, `:253-282`, `:380-397`; inspection `systemPrompt` |
| Jobs contract types | `cordis_inspect_query` Host `Service` → `jobs` |
| Jobs runtime validation/settlement/notices | `$PKG/dsh-jobs-local/lib/index.js:412-423`, `:489-500`, `:537-556`, `:644-655`, `:769-796`, `:831-839`; `$PKG/dsh-jobs/README.md:12-44`; `$PKG/dsh-tool-jobs/lib/index.js:256-296`; `README.md:38-42` |
| Working directory / agents / initiator | inspection `workingDirectory`, `agents`; `$PKG/dsh-agent/README.md:28-67`, `:111-113` |
| Subprocess contract + local provider | inspection `subprocess`; `$PKG/dsh-subprocess-local/README.md:10-68` |
| Sandbox/approval boundary for plugin code | `$PKG/dsh-plugin-manager/README.md:31`; `$PKG/dsh-bash-sandbox/README.md:28-32`, `:58-60`, `:78-97` |
| Filesystem service | inspection `fs` |
| Config/inject/effect patterns | `$SKILL/references/host-plugin.md:57-64`; `$SKILL/references/practices.md:16-23`; `$PKG/dsh-jobs-local/lib/index.js:356-362`, `:402`, `:804`; `$PKG/dsh-tool-jobs/lib/index.js:82-93`, `:223-261`, `:418` |
| Plugin root / assets via `import.meta.url` | `$PKG/dsh-app-boot/lib/index.js:271-275`; `$PKG/dsh-skill-badge/lib/index.js:10-15` |
| Skills service contract | `cordis_inspect_query` Host `Service` → `skills` |
| Runtime skill registration/validation/defaults | `$PKG/dsh-skill/lib/index.js:17`, `:193-215`, `:427-469`, `:471-503`; `README.md:28-68` |
| Filesystem skill roots/config/format | `$PKG/dsh-skill-filesystem/README.md:34-77`, `:144-151` |
| Bundled provider example | `$PKG/dsh-skill-badge/lib/index.js:10-51` |
| Cordis inject/effects basics | `$PKG/cordis/README.md:61-67` |
| Profile files / bundle order / HMR presence | profile dir files; `Config.listConfigs`; `cordis_inspect_query` `hmr` |

---

## 17. Known gaps / risks (read before authoring)

1. **`lib/types/**/*.d.ts` are absent in this packaged app** — do not plan on
   reading them. `cordis_inspect_query` contracts are generated from the
   installed packages and were used as the authoritative type source here;
   `lib/*.js` and READMEs fill in semantics.
2. **Peer-dependency resolution is the one sharp edge.** If `index.js` imports
   `@deepseek-ai/*`, omit a peer entry and the plugin fails to import
   (`ERR_MODULE_NOT_FOUND`), or declare an incompatible `dsh-*` range and the
   bundle is skipped (`skippedBundles`) / install refused. The zero-import v1
   avoids both; if you go with `defineTool`/`Config`, declare exactly
   `0.2.1-rc.2` for every `@deepseek-ai/dsh-*` peer.
3. **Installed Host code is trusted and unsandboxed**; there is no approval gate
   on a plugin's own subprocess/fs effects (`plugin-manager/README.md:31`).
   Keep Codex invocations explicit-argv and bounded; honor `exec.signal`.
4. **`kind` is type-restricted but runtime-open.** A custom job kind works in
   plain JS; TypeScript authors would need a cast because `JobKindMap` only lists
   `bash` (inspection `jobs`; `dsh-jobs-local/lib/index.js:412-419`). `job_list`
   renders `[<kind>]` verbatim.
5. **Background jobs require a controller** — `ctx.jobs.start()` throws if
   `@deepseek-ai/dsh-tool-jobs` is not in the agent composition
   (`dsh-jobs-local/lib/index.js:413-414`). In this profile it is present for
   normal agents; other presets may not mount it.
6. **HMR vs restart**: a brand-new bundle activates live; a replacement of a
   loaded package needs a restart for fresh JS; config-only changes hot-apply.
7. `plugin_manager` actions need danger-full-access/approval; Desktop owns
   package operations. The Lead (not this analyst) performs the install.
