# Contracts — the source of truth for every module

This file pins the wire formats, endpoints, limits, and MCP surface. Code
conforms to this document; if a change is needed, change this file in the
same commit and say why in the commit message. Anything not specified here
is an implementation choice; anything specified here is a contract.

Provenance note: this project contains **no sensor-fusion algorithms**. The
phone's OS fuses IMU data and the browser hands us the result
(`deviceorientation` events). We validate, buffer, classify activity with
textbook heuristics, and serve. All algorithm constants below are defined in
this file, from public literature, not ported from anywhere.

## Roles and flow

1. **Desktop browser** opens `/` → clicks **Start a session** →
   `POST /api/session` → shows (a) the MCP connector URL to paste into
   claude.ai, (b) a 6-digit pairing code.
2. **Phone browser** opens the same site root → enters the code →
   `POST /api/claim` → redirected to `/s/<token>` → user taps **Start**
   (the tap is required: iOS only grants sensor permission from a user
   gesture) → streams frames to `POST /ingest/<token>`.
3. **claude.ai** (custom connector) speaks MCP over Streamable HTTP at
   `POST /mcp/<token>`.
4. Either side can **End & erase** (`POST /api/end/<token>`) → immediate
   `deleteAll`. Idle sessions self-erase after the TTL via a Durable Object
   alarm.

## Identity and pairing

- **token**: 22 chars of base64url (128 bits from `crypto.getRandomValues`).
  Appears only as a URL path segment. Comparison is constant-time.
  Possession of the token = full access to the session (capability URL).
  This is the documented, deliberate security model for a demo that holds
  no coordinates and nothing older than 30 minutes.
- **pairing code**: 6 decimal digits, single-use, expires 300 s after
  minting, at most 10 failed claim attempts before the code is invalidated.
  Codes live in the singleton `Lobby` Durable Object; sessions live in
  per-token `MotionSession` Durable Objects (`idFromName(token)`).
- Invalid token or code → uniform `404 {"error":"unknown session"}`.
  Never distinguish "bad token" from "expired session".

## HTTP endpoints

| Method | Path | Body → Response | Notes |
|---|---|---|---|
| OPTIONS | any path | → `405` | checked first, before all routing: no preflight is ever answered and no CORS headers exist; the page is same-origin by design |
| GET | `/`, `/s/<token>` | static page | assets; SPA fallback |
| any | `/.well-known/*` | → `404 {"error":"not found"}` | uniform for every method (except OPTIONS, above), never the SPA fallback: MCP clients probe OAuth discovery here, and a `200` reads as "this server has a sign-in service" |
| POST | `/api/session` | `{}` → `{token, code, mcpPath, expiresInS}` | rate-limited in Lobby: ≤ 10 new sessions per 10 min globally |
| POST | `/api/claim` | `{code}` → `{token}` | one-shot; see pairing rules |
| POST | `/ingest/<token>` | `{frames:[Frame]}` → `{accepted:int}` | ≤ 25 frames/batch, ≤ 32 KiB body, ≤ 15 requests / 10 s |
| GET | `/status/<token>` | → `Status` | polled by both page roles at ≤ 1 Hz |
| POST | `/mcp/<token>` | JSON-RPC 2.0 → JSON | MCP Streamable HTTP; ≤ 60 req/min |
| GET | `/mcp/<token>` | → `405` | stateless server: no server-initiated stream |
| POST | `/api/end/<token>` | `{}` → `{erased:true}` | immediate `storage.deleteAll()` |

Every response carries: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, and for HTML
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
Do **not** send a `Permissions-Policy` that disables `accelerometer`,
`gyroscope`, or `magnetometer` — the page needs them.

Rate-limit excess → `429` with `Retry-After` seconds.

## Frame (phone → server)

```jsonc
{
  "tMs": 1753795200000,       // phone epoch ms — used ONLY for intra-batch
                              // ordering & cadence deltas; freshness is
                              // computed from SERVER receive time, so phone
                              // clock skew cannot fake freshness
  "headingDeg": 123.4,        // [0,360) or null
  "pitchDeg": -12.0,          // [-90,90] or null
  "rollDeg": 4.2,             // [-180,180] or null
  "headingAbsolute": true,    // true only if the platform gave a
                              // compass-referenced heading
  "aMag": 10.1                // accelerometer magnitude m/s², [0,80] or null
}
```

Validation (server, per field): every number must pass `Number.isFinite`
**before** any range check (`x < lo || x > hi` is false for NaN — the gate
must fail closed, so use `!(x >= lo && x <= hi)` or an explicit finite
check). Reject the whole batch with `422` and a per-field error message on
the first invalid frame. Unknown extra keys → `422` (strict schema).
`tMs` must be a safe integer > 0.

The page derives `headingDeg/pitchDeg/rollDeg` from `deviceorientation`
(`alpha/beta/gamma` + `screen.orientation.angle` compensation; on iOS use
`webkitCompassHeading` for an absolute heading, and set
`headingAbsolute:false` when only relative `alpha` is available). `aMag` is
`Math.hypot(x,y,z)` from `devicemotion`'s `accelerationIncludingGravity`.
Target ~5 Hz sampling, one `POST` per second (≤ 25 frames tolerates bursts).

## Ring buffer & ephemerality

- `MotionSession` keeps at most **30 minutes** of frames (ring, cap 9 000).
- Idle TTL: **60 minutes** with no ingest AND no MCP call → alarm fires →
  `storage.deleteAll()`. Every ingest/MCP call re-arms the alarm.
- Nothing is ever written outside the Durable Object; no logs contain frame
  values; there is no analytics of any kind.

## Activity classification (server-side, `src/core/activity.ts`)

Over the most recent 4 s window of `aMag` samples (need ≥ 8 samples,
newest ≤ 3 s old, else `unknown`):

1. Remove the window mean. Let `sd` = standard deviation.
2. Count peaks: local maxima with prominence ≥ 0.6 m/s² and ≥ 0.35 s
   spacing. Cadence (steps/min) = peaks / coveredSeconds × 60, where
   `coveredSeconds` is the span the window's samples actually cover — the
   first-to-last sample gap plus one nominal sample interval (window ÷ 20 ≈
   0.2 s), capped at the 4 s window — not a fixed 4 s. For a fully populated
   window the two coincide; for a partially covered one the denominator is the
   real coverage, so cadence is not diluted by the empty part of the window.
   Doubling a half-cadence signal is NOT attempted — report what was measured.
3. Classify:
   - `stationary` if `sd < 0.25` m/s²
   - `running` if cadence ≥ 144 spm and `sd ≥ 1.5`
   - `walking` if cadence in [72, 144) spm and `sd ≥ 0.25`
   - else `unknown`
4. `confidence` ∈ [0,1]: 0.9 for clean classifications, degrade toward 0.3
   as sample count or window coverage shrinks (exact curve is an
   implementation choice; monotonicity in evidence is the contract — adding a
   sample or extending coverage never lowers confidence, so the coverage term
   is driven by the sample span, not by a `1/(n−1)` factor that would fall as
   an interior sample arrived).

`cadenceSpm` is `null` when `stationary` or `unknown`.

## MotionState (MCP tool output, `structuredContent`)

```jsonc
{
  "freshSeconds": 1.8,             // server-clock age of newest frame; null if none
  "orientation": {                 // null if no orientation frames in last 3 s
    "headingDeg": 123.4, "pitchDeg": -12.0, "rollDeg": 4.2,
    "headingAbsolute": true
  },
  "activity": "walking",           // stationary|walking|running|unknown
  "cadenceSpm": 112,               // null unless walking/running
  "confidence": 0.9,
  "samples": { "count": 412, "windowSeconds": 240 },
  "session": { "ageSeconds": 610, "expiresInSeconds": 3010 }
}
```

Missing data is `null`, never a fabricated zero — this mirrors the parent
project's honesty contract and is the point of the demo.

## MCP (Streamable HTTP, stateless)

- Supported protocol version: `2025-06-18`. `initialize` echoes it when the
  client requests it, and negotiates every other requested version — including
  the older `2025-03-26`, down to it. Only `2025-06-18` is advertised because
  that revision removed JSON-RPC batching from the wire schema, which is what
  makes rejecting a batch (below) conformant rather than advertising a version
  whose messages the server does not accept.
- Handle: `initialize`, `notifications/initialized` (→ 202 empty),
  `ping`, `tools/list`, `tools/call`. Unknown method → JSON-RPC error
  `-32601`. A `tools/list`/`tools/call` arriving **without** a prior
  `initialize` MUST work (stateless server; cold calls are legal here).
- JSON-RPC batches (a top-level array) are not accepted → `-32600`; legal
  under `2025-06-18`, which removed batching.
- The `MCP-Protocol-Version` request header is not inspected. The server is
  stateless and every tool response is identical across versions, so a
  mismatched or absent header cannot change a result; validating it would buy
  no correctness and is deliberately omitted.
- Responses are plain `application/json` (no SSE). No `Mcp-Session-Id`.
- `serverInfo.name`: `proprioceptor-lite`.
- Tools (names are a stability contract):
  - `motion_get_current_state`: full `MotionState`.
  - `motion_get_orientation`, `{freshSeconds, orientation}` only.
  - `motion_summarize_session`: over the whole ring:
    `{windowSeconds, samples, movingPercent, stationaryPercent,
    unknownPercent, avgCadenceSpm, headingRangeDeg:{min,max}, activityBouts:
    [{activity, startOffsetS, durationS}] (≤ 20 bouts, newest last)}`.
    `movingPercent + stationaryPercent + unknownPercent` sum to 100
    (largest-remainder apportionment over the classified windows).
    `headingRangeDeg` is the literal numeric minimum and maximum of the
    observed `headingDeg` values in [0,360); it is **not** a circular arc and
    does not account for the 0/360 seam, so a device merely wobbling around
    north can report a wide `min`–`max`. A seam-aware circular range is possible
    future work; today the field is exactly the two observed extremes.
- Every tool result includes BOTH `structuredContent` (above) and a short
  readable `content[0].text` rendering. All values are numbers/enums
  produced by our own code no user-authored text exists anywhere in the
  pipeline (there is deliberately no device-name field in v1).
- Tool input schemas: `{"type":"object","properties":{},"additionalProperties":false}`
  (no arguments in v1).

## Status (page polling)

```jsonc
{
  "phone":  { "streaming": true, "rateHz": 4.8, "lastFrameAgeS": 0.4 },
  // rateHz and lastFrameAgeS are both null until the first frame arrives
  "mcp":    { "totalCalls": 7, "lastCallAgeS": 12.1 },   // lastCallAgeS null if none
  "session":{ "ageS": 610, "expiresInS": 3010 }
}
```

## Non-goals (v1)

No precise location, no GPS, no fall detection, no accounts, no push, no
WebSockets, no persistence beyond the ring, no free-text fields, no
external requests from the page (CSP-enforced), no npm runtime
dependencies (dev-tooling only).
