# Contributing to dsh-codex

Thanks for wanting to make Codex inside DeepSeek Harness better.

## Development loop

```bash
git clone https://github.com/AmrMohamad/dsh-codex.git
cd dsh-codex/dsh-codex
npm test          # hermetic tests, no Codex calls
```

Install the bundle locally for live testing:

```text
plugin_manager  action: install_bundle
                target: <repo>/dsh-codex
```

The bundle is linked, so edits to `index.js` and `lib/` take effect after a profile
recomposition (toggle the bundle in the Plugin Manager). Vendored `runtime/` scripts are
spawned per run, so they pick up edits immediately.

Start with [AGENTS.md](AGENTS.md): it maps every module and lists the invariants a change
must keep.

## What a good PR looks like

- One focused change with a short “why” in the description.
- A regression test for every behavioral fix (`test/regressions.test.mjs` for review
  findings, `test/upstream-fixes.test.mjs` for upstream issues). It must fail without the fix.
- No new peer dependencies: the bundle is deliberately zero-import.
- Docs updated: tool/command descriptions, prompt section, skills, README, and
  `docs/REVIEW.md` when the change closes a known finding.
- `npm test` green. If you touched the vendored runtime, note it under “Modifications” in
  `dsh-codex/NOTICE` and keep the Apache-2.0 notices intact.

## Review expectations

This project has been reviewed by Codex itself and an independent reviewer; see
[`docs/REVIEW.md`](docs/REVIEW.md). Reviews here are adversarial by design: we care about
cancellation races, approval gaps, protocol drift, and recovery from a broken CLI.
Expect questions about failure modes, not just the happy path.

## Security

Do not open a public issue for a security problem. Instead, describe the impact and a
minimal reproduction privately to the maintainer, or open a draft security advisory on
GitHub. Never include credentials, `~/.codex` contents, or customer data in reports.

## Scope

In scope: Harness integration, Codex protocol handling, safety, packaging, docs, tests.
Out of scope: changes to OpenAI Codex itself, changes to DeepSeek Harness core, and
features that require a separate account or proprietary runtime.
