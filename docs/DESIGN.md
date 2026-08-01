# Design

This document explains the *why* behind `docs/CONTRACTS.md`, which stays the
source of truth for the actual numbers and wire formats. Nothing here
overrides it.

## No sensor fusion happens here

Worth repeating from the README: this repo runs no fusion algorithm. A
phone's operating system already turns raw accelerometer, gyroscope, and
compass samples into an orientation, and the browser hands that number over
via `deviceorientation` as-is. Everything server-side is validation, a ring
buffer, a small activity classifier built from textbook heuristics, and an
MCP surface. Precise location, GPS, and any health inference are out of
scope on purpose — see [Non-goals](#non-goals-v1).

## Two Durable Objects, not one

- **`Lobby`** is a process-wide singleton. It mints and claims 6-digit
  pairing codes and rate-limits new-session creation. Pairing needs one
  shared namespace: two phones racing to claim a code must contend on the
  same counter, not two independent ones.
- **`MotionSession`** is addressed per token (`idFromName(token)`) and holds
  one session's ring buffer, serves `/status`, `/ingest`, and `/mcp`, and
  owns its own alarm. Splitting it out this way makes every session its own
  storage boundary: `deleteAll()` on one token can never touch another, and
  the object's own alarm is a natural, local place to hang idle-TTL logic —
  no cross-session sweep job needed anywhere.

## Freshness is server time, not phone time

`Frame.tMs` is the phone's own clock, used only for ordering frames and
computing cadence deltas *inside* a batch. `freshSeconds` in `MotionState`
is always `serverNow - serverReceivedAt`. A phone with a wrong clock, or a
client that is simply lying, cannot make stale data look fresh — the server
never trusts a client's opinion of "now" for anything freshness-related.

## MCP is stateless, and cold calls are legal

There's no `Mcp-Session-Id`, no SSE stream, and no server-held connection
state — every `initialize`, `tools/list`, or `tools/call` is a
self-contained POST, authenticated by the token in the path alone. A
`tools/call` that arrives without a prior `initialize` must still work,
because there is no session object that could have required one. This maps
directly onto a Worker's request/response model: nothing to hibernate,
nothing to reconnect, nothing to leak between requests.

## No WebSockets in v1

Sampling targets roughly 5 Hz, and the page batches one `POST /ingest` per
second (a 25-frame cap tolerates jitter); status polling is capped at 1 Hz.
A plain batched POST already clears that bar with room to spare, so a
persistent push channel would only add operational weight,  Durable Object
WebSocket hibernation, reconnect handling, extra CSP surface for a latency
need nobody has yet. Revisit only if a future feature genuinely needs
sub-second delivery.

## Why classification lives on the server

The activity heuristic (`src/core/activity.ts`) runs entirely server-side so
the phone page can stay dumb: it relays validated numeric frames and
nothing else. That keeps the classifier in exactly one place, testable
against `docs/CONTRACTS.md` in isolation from any UI concern, and means a
page change can never silently redefine what "walking" means.

## The activity heuristic, and where its numbers come from

Over the most recent 4-second window of `aMag` samples (needs at least 8
samples, newest no more than 3 s old, else the window is stale and the
result is `unknown`):

1. Subtract the window mean; call the resulting standard deviation `sd`.
2. Count peaks with prominence at least 0.6 m/s² and at least 0.35 s
   spacing; cadence (steps/min) is the peak count divided by the span the
   samples actually cover capped at the 4 s window, not diluted by the empty
   part of a partly-filled window — and scaled to a minute.
3. Classify by `sd` and cadence together:
   - `sd < 0.25` m/s² → **stationary** — this reads as handheld or pocket
     noise, not a gait signal.
   - cadence ≥ 144 spm and `sd ≥ 1.5` → **running**.
   - cadence in [72, 144) spm and `sd ≥ 0.25` → **walking**.
   - anything else → **unknown**.
4. `confidence` degrades from 0.9 toward 0.3 as sample count or window
   coverage shrinks. The exact curve is an implementation choice; the only
   contract is that it never drops *because* there was more evidence.

The 72–144 steps-per-minute band is the commonly cited normal adult walking
cadence range in gait-analysis literature; running sits above it. Prominence
and spacing thresholds reject sensor noise and handheld wobble from being
counted as steps at all. None of these constants came from the private
Proprioceptor codebase — they are defined fresh, in `docs/CONTRACTS.md`,
from public literature.

## Ephemerality mechanics

- Ring buffer: capped at 9,000 frames, about 30 minutes at target sampling
  rate.
- Idle TTL: 60 minutes with no ingest and no MCP call arms a Durable Object
  alarm; any ingest or MCP call re-arms it.
- An alarm firing and `POST /api/end/<token>` both do the same thing:
  `storage.deleteAll()`. There is no soft delete and no recovery.

## Non-goals (v1)

| | |
|---|---|
| No precise location, no GPS | No accounts |
| No fall or health detection | No push notifications |
| No WebSockets | No persistence beyond the ring |
| No free-text fields anywhere | No external requests from the page (CSP-enforced) |
| No npm runtime dependencies | |

## Data flow

```
 phone (deviceorientation/motion)       claude.ai (MCP client)
   │ POST /ingest/<token> {frames} ~1/s   │ POST /mcp/<token> JSON-RPC
   ▼                                      ▼
 ┌──────────────────────────────────────────────────┐
 │  Cloudflare Worker: routing, validation,         │
 │  rate limits, CSP + security headers             │
 └──────────────┬────────────────────┬──────────────┘
                │ idFromName(token) splits by path
                ▼                    ▼
 ┌──────────────────────┐  ┌──────────────────────────┐
 │      Lobby (DO)      │  │    MotionSession (DO)    │
 │  code ↔ token        │  │  ring buffer (30 min)    │
 │  mint / claim        │  │  activity classifier     │
 │  session rate cap    │  │  serves /status + /mcp   │
 └──────────────────────┘  │  alarm → deleteAll()     │
                           └──────────────────────────┘
```
