# Contributing

## Prerequisites

**Node.js 20 or newer** (CI runs 22) and `npm`. Per-platform install
instructions, and what to do when `node` itself won't start, are in
[README.md § Requirements](README.md#requirements) and
[QUICKSTART.md § Troubleshooting setup](QUICKSTART.md#troubleshooting-setup).

Beyond deploying, contributors need one extra thing: a Chromium build for the
Playwright suite, fetched once with `npx playwright install --with-deps
chromium`. On Linux the `--with-deps` part installs system libraries and will
ask for `sudo`; see [Running Playwright locally](#running-playwright-locally) if
your sandbox already provides a browser.

## Gates that must stay green

```sh
npm run typecheck   # tsc -b
npm run test        # vitest (core + server)
npm run test:web    # playwright (chromium)
```

These are exactly the jobs in `.github/workflows/ci.yml`. If they pass
locally, CI passes.

## Contracts first

`docs/CONTRACTS.md` is the source of truth for wire formats, endpoints,
limits, and the MCP surface. If a change touches any of those, update
`docs/CONTRACTS.md` in the **same commit** as the code, and say why in the
commit message. `src/core/types.ts` mirrors the contract and moves with it,
never ahead of it, never behind.

## House rules

- **NaN-fail-closed.** Validate every numeric field with a finite check
  before any range comparison. `x < lo || x > hi` silently passes `NaN` —
  write the inverted form (`!(x >= lo && x <= hi)`) or check
  `Number.isFinite` explicitly first.
- **Null over guesswork.** Missing or stale data is `null`. Never fill in a
  zero, a last-known value, or a best guess in its place, that is the
  honesty contract this repo exists to demonstrate.
- **No runtime dependencies.** Nothing gets added to `dependencies` in
  `package.json`. `devDependencies` (TypeScript, Vitest, Playwright,
  `@cloudflare/workers-types`) are the only kind this repo has.

## Running Playwright locally

`npm run test:web` downloads and launches Chromium normally. In a sandbox
without network access to fetch a browser, point Playwright at a
preinstalled one instead:

```sh
CHROMIUM_PATH=/path/to/chromium npm run test:web
```

`playwright.config.ts` reads that variable and skips the download when it's
set; CI leaves it unset and installs Chromium normally.

## Dev environment

Open this repo in GitHub Codespaces or a local VS Code Dev Container and
`postCreateCommand` runs `npm install` plus a Playwright Chromium install
for you, no manual setup before the gates above will pass. Before
committing, run the `/preflight` skill (`.claude/skills/preflight/`): it
runs every gate CI runs and tells you which one is red, if any.

## Provenance

Write fresh code and fresh prose. Nothing here is ported from the private
Proprioceptor codebase or its sibling repos,  algorithm constants in
`docs/CONTRACTS.md` are cited to public literature, not copied from
anywhere.
