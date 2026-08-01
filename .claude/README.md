# .claude/

Project-level Claude Code configuration: permissions, a fast-feedback hook,
review subagents, and the `/preflight` skill. None of this is a substitute
for CI — `.github/workflows/ci.yml` and `npm run check` are still the real
gates.

## Why the PostToolUse hook always exits 0

`settings.json`'s hook runs `npm run -s typecheck` after an Edit/Write, but
only as a quick nudge while you're mid-change, not as an enforcement point.
It degrades to a no-op if `jq` isn't installed (falls back to a stdin
`grep`/`sed` parse of `tool_input.file_path`) and it never propagates a
non-zero exit — the `npm run -s typecheck || true` and the trailing
`exit 0` are both deliberate. A hook that can block a tool call on its own
plumbing failure (missing `jq`, an unexpected payload shape) is worse than
one that occasionally stays quiet: it would stall editing over something
that has nothing to do with the actual change. Real enforcement happens at
commit time via the `/preflight` skill and in CI, where a red gate is
supposed to stop you.
