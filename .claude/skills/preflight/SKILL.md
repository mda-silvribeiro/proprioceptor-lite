---
name: preflight
description: Run every gate the CI runs, locally, and summarize pass/fail with the failing output if any. Use before any commit.
---

Run the same gates `.github/workflows/ci.yml` runs, in this order, and stop
to report as soon as one fails rather than pushing on past it:

```sh
npm run typecheck
npm run test
```

Then the Playwright suite. If a preinstalled Chromium exists at
`/opt/pw-browsers/chromium` (the sandboxed-environment convention described
in CONTRIBUTING.md), point Playwright at it; otherwise let it install its
own, exactly as CI does:

```sh
if [ -e /opt/pw-browsers/chromium ]; then
  CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:web
else
  npm run test:web
fi
```

## Reading failures

- `npm run typecheck` failure: a `tsc -b` error with `file:line`. Fix the
  type error at its source — don't paper over it with `any` or a stray
  `@ts-expect-error`.
- `npm run test` failure: a Vitest report naming the failing test and
  assertion. If the failing test is a regression test (CLAUDE.md and
  CONTRIBUTING.md both say: never delete one), the fix belongs in the
  code, not the test.
- `npm run test:web` failure: a Playwright report. Re-run the same command
  with `--reporter=list` for a terser trace if the default output is hard
  to read.

## The rule

Summarize as one pass/fail line per gate (typecheck, test, test:web). Any
red gate blocks the commit — fix it, or if the failure clearly predates
your change say so explicitly, but never commit past a gate that is
currently red.
