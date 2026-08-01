# Data protection record

A lightweight record of processing for proprioceptor-lite, in the spirit of
GDPR **Article 30**, plus a US state-law (CCPA/CPRA) note. It exists so a
deployer, who is the responsible party, not the repo author, can see the whole
processing picture on one page.
and [../PRIVACY.md](../PRIVACY.md) (the plain-language account).

**Not legal advice.** Roles below describe the shipped software; your obligations
depend on how you deploy it and where you are.

## Roles

| Role | Who | Notes |
|---|---|---|
| Controller | **The person who deploys the instance** | Decides the purpose and means. For self-only use this is you-about-you (household activity, GDPR §2(2)(c)). The repo author is **not** a controller: they run no server and receive no data. |
| Processor | Cloudflare (Workers + Durable Objects) | Hosts the deployer's instance under the deployer's own account and Cloudflare's terms. |
| Processor / recipient | The deployer's AI provider (e.g. Anthropic) | Receives a tool result **only** when the deployer asks a question that calls a tool; governed by the deployer's own agreement with that provider. |
| Data subject | Whoever holds the sensing phone | The deployer in the intended case; anyone they let pair, otherwise. |

## Processing activities

| Purpose | Categories of data | Legal basis (GDPR) | Retention | Recipients |
|---|---|---|---|---|
| Interpret and relay device motion to the user's own LLM | Orientation angles; accelerometer magnitude; derived activity/cadence; frame/receive timestamps | Household activity (§2(2)(c)) for self-use; **consent** (Art. 6(1)(a)) where another person is sensed — given by tapping *Start*, withdrawn by *End & erase* | Frame ring ≤ 30 min; whole session self-erases after 60 idle min or on demand | The user's AI provider, only on an explicit tool call |
| Pair a phone to a session | 128-bit token; 6-digit code | Necessary to provide the requested service (Art. 6(1)(b)) / consent | Code ≤ 5 min, single use; token for session lifetime | none |

Explicitly **not** processed: precise location/GPS, identity, account, email, IP
(by the app), any free-text field. No profiling with legal/similar effect, no
automated decisions, no cross-context behavioural advertising, no sale or share.

## Data-subject / consumer rights, and how the software already serves them

| Right | How it is met |
|---|---|
| Erasure / deletion | **End & erase** wipes the session immediately (`storage.deleteAll()`); idle sessions self-erase after 60 min. There are no backups. |
| Storage limitation | Ring holds ≤ 30 min; nothing persists beyond the session. |
| Access / portability | The live MCP tools return exactly what is held, in JSON. |
| Withdraw consent | Stop streaming and/or **End & erase** — no residue remains to withdraw from. |
| Transparency | In-page notice at the point of collection (near *Start*), plus PRIVACY.md and this record. |

Because retention is minutes and there is no identity key, most "give me
everything you hold about person X" requests are satisfied structurally: after a
session ends there is nothing left to produce.

## International transfers

Data is processed in the deployer's own Cloudflare account (region per their
configuration) and, on an explicit tool call, sent to the deployer's chosen AI
provider under that provider's terms. The repo author facilitates no transfer.

## CCPA / CPRA (and similar US state laws)

For a US deployer:

- Self-only use is not the regulated collection of *a consumer's* personal
  information, it is your own data about yourself.
- There is **no sale and no sharing** for cross-context behavioural advertising anywhere
  in this software. The deletion right maps onto *End & erase* and the automatic
  TTL.
- There is no processing of a "consumer" at scale, no financial-incentive
  program, and no sensitive-PI monetisation to disclose.

---