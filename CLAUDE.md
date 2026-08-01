# proprioceptor-lite

Phone browser → your own Cloudflare Worker → MCP → claude.ai. No sensor
fusion happens here: the phone OS fuses IMU data and the browser hands over
the result; this repo validates, buffers, classifies activity with textbook
heuristics, and serves MCP. `docs/CONTRACTS.md` is the contract;
`docs/DESIGN.md` is the why.

## Commands

```sh
npm run typecheck   # tsc -b
npm run test        # vitest (core + server)
npm run test:web    # playwright (chromium)
npm run dev         # wrangler dev
npm run deploy      # wrangler deploy
```

## Territory

- `src/core/` is platform-free: no Workers/DOM APIs, no runtime deps.
- The Worker entry point and the Durable Object classes are the only
  Cloudflare-aware files; everything else stays portable.
- `web/` is plain, checkJs-strict JS (`tsconfig.web.json`) — no framework.

## Hard rules

- Contracts first: touching a wire format, endpoint, limit, or MCP surface
  means updating `docs/CONTRACTS.md` in the same commit, with why in the
  commit message.
- NaN-fail-closed: finite check before range check, always.
- Null over guesswork: missing data is `null`, never a fabricated value.
- Zero runtime npm dependencies, ever.
- Fresh code and prose only — nothing ported from the private Proprioceptor
  codebase or its sibling repos.
