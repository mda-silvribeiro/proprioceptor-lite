# Privacy

A plain-language account of what this app does and doesn't do with your
data. For precise wire-level detail see [docs/CONTRACTS.md](docs/CONTRACTS.md);
for the security tradeoffs behind the design see [SECURITY.md](SECURITY.md).

## What exists

While a session is running, your own Cloudflare instance holds:

- Orientation angles (heading, pitch, roll) and whether the heading is
  compass-referenced or only relative.
- Raw accelerometer magnitude, one number, `|acceleration|` in m/s², per
  frame. This is the actual input the activity classifier runs on. Like every
  other frame value it lives only in the buffer (at most the last 30 minutes)
  and its snapshot, and it leaves your instance only inside a tool result you
  ask Claude for.
- An activity label (`stationary` / `walking` / `running` / `unknown`) and
  a cadence number when one applies.
- Per-frame timestamps: the phone's own clock, used only for ordering and
  cadence deltas, and the server's receive time, used for freshness — never a
  log of where you were and when.
- A random 128-bit session token, and a one-time 6-digit pairing code that
  expires after 5 minutes.

That's the entire list, a short, self-erasing buffer of motion numbers, plus
the token and code that address it. Explicitly, none of the following exist
anywhere
in this app, in any form:

- **No location.** No GPS, no coordinates, no place names, no maps.
- **No names, accounts, or logins.** Nobody signs up for anything, ever.
- **No IP logging by this app.** (Cloudflare's own edge has its own
  operational logs, outside this app's control, see [SECURITY.md](SECURITY.md).)
- **No free text anywhere.** Every value this app produces is a number or
  a fixed enum from a small, known set — never a string you or anyone
  else typed.

## Where it lives

Inside a single Durable Object in **your own** Cloudflare account, the
one you deployed to. The author of this repository operates no server,
receives no data, and has no way to see your session even in principle:
there is no shared backend anywhere in this design.

## Who is responsible for the data (you might be the controller)

The author's disclaimer above is precise, and it has a mirror image: because
there is no shared backend, **the person who deploys an instance is the one
responsible for whatever it processes.** Which law applies depends on who is
being sensed:

- **Your own phone and your own desktop**: the ordinary case. Under GDPR this
  is a purely personal or household activity (Art. 2(2)(c)), which sits outside
  the Regulation's scope; under US state laws it is your own data about
  yourself. Nothing is owed to anyone.
- **Someone else's phone pairs with your instance**: the pairing flow allows
  this without any code change. The moment another person's device streams to
  your Worker, you are processing *their* personal data, and under GDPR / UK
  GDPR you become the **data controller** for it (a "business" under
  CCPA/CPRA), with the usual transparency and data-subject-rights duties. The
  lawful basis the product relies on for that case is **consent**: the phone
  user taps *Start* to begin and *End & erase* to withdraw, and the in-page
  notice states what is collected before they do.

## How long

- A session's frame buffer holds at most the last **30 minutes**.
- The whole session erases itself after **60 minutes** with no phone
  activity and no Claude activity — no warning needed, none given.
- Hitting **End & erase**, from either the phone or the desktop tab, wipes
  it immediately.
- There are no backups anywhere in this design. Erased means erased.

## The one outbound flow

Nothing leaves your Cloudflare instance on its own. The single exception:
when you ask Claude a question and it calls a tool, that tool's small JSON
result travels to your AI provider as part of that chat turn — exactly
like any other message you send. What that provider does with it after
that is governed by your own account settings with that provider, not by
this app; check your provider's data controls if that matters to you.