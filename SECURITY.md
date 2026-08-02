# Security Policy

## Supported versions

Only the latest `main` is supported. This is a template repo: everyone who
deploys it runs their own copy on their own Cloudflare account, so
"supported" means "the code currently in this repository," not a set of
maintained release branches or a hosted service with a patch schedule.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository:
open [Report a vulnerability](https://github.com/mda-silvribeiro/proprioceptor-lite/security/advisories/new)
(the same form lives under the Security tab). How the process works on
GitHub's side is described in
[their private-reporting documentation](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).
Do not open a public issue for a security problem. There is no email
address for reports, the GitHub form is the only channel.

## The security model

Every session is protected by exactly one thing: a 128-bit random token
that lives in a URL path (`/s/<token>`, `/mcp/<token>`, `/ingest/<token>`).
Anyone who has that URL can read the session's *current* orientation and
activity, and can end the session, for as long as it stays alive. There is
no login, no per-request signature, and no second factor. This is a
**capability URL**, not an authentication system, and that is a deliberate
choice, not an oversight.

Two different clocks bound the exposure, and it is worth being exact about
them. The frame buffer holds at most the last **30 minutes** of motion, so a
reader never sees anything older than that. But the *session itself* lives on
a **60-minute idle timer** that every ingest and every MCP call re-arms, so
a session that is actively streamed, or actively read, stays alive and
readable until 60 minutes after the last activity, not a flat 30. A leaked
URL is live for as long as the phone keeps streaming, plus up to an hour of
idle after it stops.

It is the right tradeoff here because of what is actually at stake: the
token never unlocks coordinates, a name, an account, or any free-text field,
there isn't one anywhere in this pipeline. The worst case of a leaked URL
is a stranger learns you were probably walking, and roughly which way you
were facing, while the session lasts; once it ends, nothing older than its
30-minute buffer ever existed to breach later. That is a small,
self-expiring blast radius, bounded by the idle timer, not by a flat
half-hour.

It is explicitly **not** suitable for anything more sensitive. If you fork
this repo to add precise location, health signals, or anything else with
real consequences if leaked, do not reuse "possession of the URL equals
access" as the access model. Add real authentication first.

## Mitigations already in place

- Token comparison is constant-time.
- An unknown token and an expired session return the exact same
  `404 {"error":"unknown session"}`, nothing distinguishes them.
- Rate limits: at most 10 new sessions per 10 minutes (global), at most 15
  ingest requests per 10 seconds per session, at most 60 MCP requests per
  minute per session. Pairing codes expire 300 seconds after minting and
  lock out after 10 failed claim attempts.
- Ingest bodies are capped at 32 KiB and 25 frames per batch.
- Every numeric field is validated with a NaN-fail-closed gate (a finite
  check before any range check) and unknown keys are rejected outright.
- A strict `Content-Security-Policy` with no external origins, the page
  cannot be made to call out anywhere else, even if something client-side
  were compromised.
- Zero runtime npm dependencies in the deployed Worker.
- The application never logs a frame value, and there is no analytics of
  any kind at this layer.
- Session storage is a SQLite-backed Durable Object, wiped by an alarm on
  idle timeout and by an explicit `deleteAll()` on "End & erase."

## Out of scope

- **Application-layer denial of pairing.** The new-session and claim paths
  share one global `Lobby` object, so their limits are global to a deployment:
  an unauthenticated caller can spend the 10-per-10-minutes new-session budget,
  or drive failed-claim attempts against the outstanding pairing codes, and so
  briefly deny *new* pairings deployment-wide. This is accepted, not defended.
  Every instance is a single owner's personal deployment (see *Supported
  versions*), so the blast radius is that one owner's own demo; an
  already-paired, streaming session keeps working throughout; and no data is
  exposed by it. Partitioning the limits per client would need per-request
  identity this zero-dependency demo deliberately does not carry.
- Denial-of-service against Cloudflare's own edge, that is their
  infrastructure to defend, not this application's.
- A compromised phone or browser. If the device itself is untrustworthy, no
  control at this layer can help.
- What your AI provider does with a tool result after you ask for it. Once
  data leaves this Worker inside a chat turn, its retention is governed by
  that provider's own policies and settings, not by this repository, check
  your provider's own data controls if that matters to you.
