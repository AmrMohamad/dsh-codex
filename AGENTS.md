# AGENTS.md — working on dsh-codex

Guide for coding agents and humans changing this repository. Read this before editing.

## What this is

A DeepSeek Harness (DSH) plugin bundle that runs the local OpenAI Codex CLI as native DSH
tools, slash commands and background jobs. The bundle lives in `dsh-codex/`. Everything
else in the repo is docs and recon evidence.

## Map

```text
dsh-codex/
├─ index.js              entry: apply(ctx, config) registers tools, commands, prompt, skills
├─ lib/                  the DSH layer (ours; plain ESM, Node builtins only)
│  ├─ tools.js           model-facing tool schemas + descriptions → operations
│  ├─ commands.js        /codex-* slash commands + parseCommandInput → operations
│  ├─ prompt.js          system-prompt section (token cost on every turn)
│  ├─ skills.js          loads skills/*.md into the skill catalog
│  ├─ operations.js      review · adversarialReview · rescue · status · result · cancel · setup
│  ├─ jobs.js            one Codex run = one DSH background job (stream, kill, collect)
│  ├─ runtime.js         createRunner(): lazy, cached node/codex resolution + run()
│  ├─ resolve.js         find node, codex, data dir (config > env > discovery)
│  ├─ process.js         spawn companion, child env, process-tree kill, prompt temp files
│  ├─ argv.js            companion argv builders (values never inline, prompts via files)
│  ├─ job-store.js       read + render durable job records (no child process)
│  ├─ diagnose.js        known failure text → one actionable "Hint:" line
│  └─ text.js            cleanOutput, shorten (surrogate-safe), tail
├─ runtime/              VENDORED from openai/codex-plugin-cc (Apache-2.0), patched
│  └─ scripts/
│     ├─ codex-companion.mjs     CLI: review | adversarial-review | task | status | result | cancel | setup
│     ├─ app-server-broker.mjs   one shared `codex app-server` per workspace
│     └─ lib/*.mjs               JSON-RPC client, turn capture, git context, state, render
├─ skills/*.md           embedded skills (frontmatter: name, description)
└─ test/*.test.mjs       hermetic node:test suites (fakes.mjs = fake ctx/jobs/runner)
```

Call path: tool/command → `operations.js` → (`jobs.js` for runs | `runDirect` for queries)
→ `runtime.js` `run()` → `process.js` spawns `node runtime/scripts/codex-companion.mjs …`
→ companion joins the workspace broker → `codex app-server` (JSON-RPC).

## Invariants (do not break)

1. **Zero bare imports.** `index.js` and `lib/` import only `node:*` builtins and relative
   files. No `@deepseek-ai/*` imports, no npm dependencies, no `peerDependencies`.
2. **Tools and commands share operations.** Never put behavior in `tools.js` or
   `commands.js`; add it to `operations.js` so both surfaces stay identical.
3. **Read-only by default.** Reviews never write. `write: true` from the model must pass
   `ensureWriteAllowed` (Harness approval, fails closed). Only a human `--write` skips it.
4. **Prompt text never travels in argv.** Use `writePromptFile` + `--prompt-file` /
   `--focus-file`, and remove the file when the run settles.
5. **Every child is a detached process group** so cancel kills the whole tree; cancel also
   interrupts the Codex turn through the companion.
6. **Bounded everything.** Output capture, job rings, failure tails, untracked-file prompt
   context, waits and interrupts all have explicit limits. Keep new buffers bounded.
7. **Report faithfully.** Errors keep the original Codex message first; hints are appended
   (`Hint: …`), never substituted. Never fabricate a Codex result.

## Changing the vendored runtime (`dsh-codex/runtime/`)

- Prefer fixing in `lib/` (ours). Patch `runtime/` only for bugs or protocol drift there.
- Keep patches small and leave a comment naming the upstream issue
  (`upstream openai/codex-plugin-cc#NNN` or `openai/codex#NNN`).
- Record each patch in `NOTICE` and `dsh-codex/NOTICE` (Apache-2.0 requires it).
- Add a regression test in `test/upstream-fixes.test.mjs` that fails without the patch.

## Tests

```bash
cd dsh-codex && npm test      # hermetic: no Codex install, no network
```

- Behavior fix → regression test (`test/regressions.test.mjs` for review findings,
  `test/upstream-fixes.test.mjs` for upstream issues, `test/diagnostics.test.mjs` for
  failure reporting).
- Prove a new test guards something: it must fail on the old code.
- Live verification needs a logged-in `codex` CLI and a DSH install; say so when you
  could not run it.

## Conventions

- ESM, 2-space indent, double quotes, semicolons; JSDoc on exported functions.
- One responsibility per `lib/` module; the file header says what it owns.
- Comments explain *why* (a failure mode, an upstream issue), not what.
- Messages for the model are short, specific, and name the next tool to call.

## Where to read more

- `docs/RESEARCH.md` — similar projects, their failure modes, and how this repo handles each.
- `docs/REVIEW.md` — the hardening review history (P1/P2 findings and fixes).
- `docs/codex-protocol.md`, `docs/dsh-host-api.md` — protocol and Host API contracts.
