<!-- Keep this short and specific. The reviewer (human or claude-code-review) is
     looking for what changed and how the invariants were kept. -->

## What & why

<!-- One or two sentences. Link an issue if there is one. -->

## Invariant checklist

- [ ] **Contracts first** — if this touches a wire format, endpoint, limit, MCP
      surface, or a classifier constant, `docs/CONTRACTS.md` is updated in the
      same PR and the commit says why. (N/A if none of those changed.)
- [ ] **NaN-fail-closed** — every new numeric gate does a finite check before
      the range check.
- [ ] **Null over guesswork** — missing/stale data stays `null`, never a
      fabricated value.
- [ ] **Zero runtime dependencies** — nothing added to `dependencies`; only
      `devDependencies` may change.
- [ ] Gates pass locally: `npm run typecheck && npm run test && npm run test:web`
      (or the `/preflight` skill is green).

## Notes for the reviewer

<!-- Anything auth-adjacent, any deliberate trade-off, anything you want a second
     pair of eyes on. Delete if nothing. -->
