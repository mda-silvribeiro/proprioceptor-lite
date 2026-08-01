# proprioceptor-lite

[![ci](https://github.com/mda-silvribeiro/proprioceptor-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/mda-silvribeiro/proprioceptor-lite/actions/workflows/ci.yml)
[![codeql](https://github.com/mda-silvribeiro/proprioceptor-lite/actions/workflows/codeql.yml/badge.svg)](https://github.com/mda-silvribeiro/proprioceptor-lite/actions/workflows/codeql.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)

Ask Claude "which way am I facing?" or "am I walking right now?" and it
answers from your phone's motion sensors, heading, tilt, and a
walking/running/stationary read, streamed from your phone's browser to your
own free Cloudflare Worker. It deliberately does not know your location,
does not infer anything about your health, and does not store anything
beyond a short-lived buffer that erases itself.

This repo contains no sensor-fusion algorithms of its own: your phone's
operating system already fuses accelerometer, gyroscope, and compass into an
orientation, and the browser just hands that result over. The server only
validates each reading, buffers it briefly, classifies activity with
textbook heuristics from public literature, and serves it over MCP, see
[What Claude sees](#what-claude-sees) and
[docs/DESIGN.md](docs/DESIGN.md) for the details, or [PRIVACY.md](PRIVACY.md)
for exactly what is and isn't collected. It's also a public,
stripped-down try-out of a larger private project — see
[Relation to Proprioceptor](#relation-to-proprioceptor).

## Requirements

To **deploy and use** an instance you need:

| | |
|---|---|
| **Node.js 20 or newer** | Ships with `npm`. An **LTS** release (22 or 24) is what you want; CI runs 22. Odd-numbered releases (21, 23, 25…) are short-lived "Current" builds and are the usual source of setup trouble. |
| **A free Cloudflare account** | No credit card, no paid plan. Durable Objects here use the SQLite backend available on the free tier. |
| **Git** | Only if you clone rather than use the `npm create cloudflare` template. |
| **A phone with motion sensors** | iOS Safari 13+, or Chrome/Firefox on Android. It must reach your Worker over **HTTPS** — `*.workers.dev` gives you that automatically; browsers refuse sensor access on plain HTTP. |

You do **not** need to install Wrangler, or anything else globally: `npm run
dev` / `npm run deploy` invoke it through `npx wrangler@4`. There are zero
runtime dependencies, and nothing in `npm install` compiles native code, so no
build toolchain (Xcode, `build-essential`, MSVC) is required.

### Installing Node

Use a version manager rather than a system package manager. It lets you pin the
LTS this project expects, and it avoids the class of breakage where an OS
package upgrade leaves the `node` binary linked against a library that no longer
exists (see [Troubleshooting setup](QUICKSTART.md#troubleshooting-setup)).

<details>
<summary><strong>macOS</strong></summary>

```sh
# Recommended: fnm (or nvm) — installs and pins Node per-project
brew install fnm

# One-time shell setup — without it, `fnm use` cannot switch versions:
echo 'eval "$(fnm env --use-on-cd)"' >> ~/.zshrc
exec zsh   # or open a new terminal

fnm install --lts   # installs the current LTS and makes it the default
node -v             # new shells pick it up automatically
```

Mind the asymmetry in fnm's flags: `--lts` belongs to `fnm install` only. To
switch an already-open shell, `fnm use` takes a version or alias — `fnm use
lts-latest` or `fnm use 24` — while `fnm use --lts` is rejected (and the
`-- --lts` spelling its error tip suggests does not work either).

Homebrew's own `node` formula also works, but it is the one most likely to break
on upgrade; if you already hit a `dyld: Library not loaded: …libllhttp…` abort,
`brew reinstall node` fixes it. The [official installer](https://nodejs.org) is
a fine alternative.
</details>

<details>
<summary><strong>Ubuntu / Debian</strong></summary>

```sh
# nvm keeps you off the distro's often-ancient Node package
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
\. "$HOME/.nvm/nvm.sh"   # load nvm into this shell; new shells load it via ~/.bashrc
nvm install --lts        # installs the current LTS, switches to it, sets the default
```

`apt install nodejs` on older releases ships Node 18 or earlier, which is below
this project's floor. [NodeSource](https://github.com/nodesource/distributions)
is the other reliable route.
</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
winget install OpenJS.NodeJS.LTS
```

Works in PowerShell and in WSL2 (follow the Ubuntu instructions inside WSL).
[nvm-windows](https://github.com/coreybutler/nvm-windows) is the version-manager
equivalent. No extra tooling is needed — this project has no native modules.
</details>

Then confirm you are above the floor:

```sh
node -v   # must print v20.x or newer
npm -v
```

Contributing as well as deploying? [CONTRIBUTING.md](CONTRIBUTING.md) covers the
one extra step, a Chromium download for the Playwright suite.

## Try it in two minutes

1. **Deploy your own instance** (needs a free Cloudflare account):
   ```sh
   npm create cloudflare@latest -- --template mda-silvribeiro/proprioceptor-lite
   ```
   or clone this repo and run `npm install && npx wrangler@4 deploy`. A
   one-click "Deploy to Cloudflare" button will also work once this repo is
   public.
2. Open your new `*.workers.dev` URL on a **desktop** browser and click
   **Start a session**. It shows an MCP connector URL and a 6-digit code.
3. Open the same URL on your **phone**, enter the code, and tap **Start**
   (the tap is required — see [Platform notes](#platform-notes)).
4. In claude.ai: **Settings → Connectors → Add custom connector**, and paste
   the MCP URL from step 2.
5. Ask Claude things like:
   - "What's my current motion state?" → `motion_get_current_state`
   - "Which way am I facing?" → `motion_get_orientation`
   - "Summarize my last few minutes of movement." → `motion_summarize_session`

Need more detail, or something not working? See
[QUICKSTART.md](QUICKSTART.md) for the expanded, step-by-step version of
the path above.

## What to ask it

The starter questions above get you one reading. The better uses come from
letting Claude *reason* over the data: comparing readings you ask for over
time, folding in what it already knows (compass declination, gait cadence
bands), and being told honestly, via `null`, when something isn't known.
One phrasing rule: there is no push channel, so Claude reads only when you
ask. "Watch me" really means "each time I ping you". And whatever you ask,
the honesty fields are there to be questioned: "how fresh was that reading,
and was the heading compass-referenced or relative?"

Five things it can do exactly as it stands:

| | Scenario | Ask something like |
|---|---|---|
| Easy | **Reality-check your restlessness.** Phone in your pocket while you work or cook; find out afterwards whether you really kept moving. | "Over the retained window, how many minutes was I moving vs still, and when was my longest stretch without moving?" |
| Medium | **A spirit level that talks.** Phone flat on the shelf, workbench, or camper you're levelling; adjust, ask again, repeat. | "Read pitch and roll. Which corner do I raise, and by roughly how much? I'll ask again after each shim." |
| Hard | **Compass-guided alignment.** Phone held flat against a satellite dish or telescope mount that needs a bearing. | "I need azimuth 203° true. My heading is magnetic, I'm in Hamburg, correct for declination, and talk me through the rotation as I re-ask." |
| Complex | **Interval coach with a memory.** Run/walk intervals; ping between sets, verdict at the end. | "Each time I say 'check', compare my cadence to a 160 spm target and tell me the trend. When I say 'done', break down the whole session's bouts." |
| Professional | **A movement log for field work.** Walkthrough audits, patrols, venue inspections, anywhere GPS is a privacy non-starter but "was I moving, when, facing which way" matters. | "Each time I say 'mark', note the time, the compass heading I'm facing, and how long I'd been standing still; at the end, table it for my report." |

Note what the hard example implies: to correct for declination, *you* tell
Claude the city. The server never knows it.

Five things the pattern could grow into — none of them in this repo today:

| It could… | What it would take |
|---|---|
| Tell you the moment you start or stop moving, unprompted | a push channel (SSE, or a polling agent), deliberately absent from the stateless design |
| Keep a day-scale movement journal | opt-in retention beyond the 30-minute self-erasing buffer |
| Recognise cycling, stairs, or riding in a vehicle | a real classifier in place of textbook cadence bands |
| Fuse two devices (watch + phone, handlebars + pocket) into one state | multi-source sessions and reconciliation logic |
| Answer "which way to the station from here" | location, which this repo deliberately never learns |

The first two are engineering; the last three are why
[Relation to Proprioceptor](#relation-to-proprioceptor) exists. This repo
stays at "honest motion, no location, nothing kept".

## What Claude sees

Every tool call returns a small, fully-typed JSON object, e.g.:

```jsonc
{
  "freshSeconds": 1.8,
  "orientation": {
    "headingDeg": 123.4, "pitchDeg": -12.0, "rollDeg": 4.2,
    "headingAbsolute": true
  },
  "activity": "walking",
  "cadenceSpm": 112,
  "confidence": 0.9,
  "samples": { "count": 412, "windowSeconds": 240 },
  "session": { "ageSeconds": 610, "expiresInSeconds": 3010 }
}
```

Missing data is always `null`, never a guess, if your phone hasn't reported
orientation in the last few seconds, `orientation` is `null`, not a stale or
made-up value. `freshSeconds` is measured by the server's own clock, so it
can't be faked by a slow phone, and `headingAbsolute` tells you honestly
whether the heading is compass-referenced or just relative to wherever
tracking started.

## How it's built

A small system with production-grade seams, kept deliberately dependency-free:

- **Contract-first.** [docs/CONTRACTS.md](docs/CONTRACTS.md) pins every wire
  shape, limit, and MCP tool; code conforms to it, and changing either requires
  the other in the same commit. A scheduled Claude job (`contract-drift.yml`)
  re-derives the constants from the code weekly and files an issue if they ever
  diverge.
- **Honest by construction.** Missing data is `null`, never a fabricated zero;
  every numeric gate runs a finite check before a range check, so `NaN` fails
  closed; freshness is measured on the server's clock so a lying phone can't
  fake it. These are the properties the demo exists to demonstrate.
- **Stateless MCP over Streamable HTTP.** No `Mcp-Session-Id`, no SSE, a cold
  `tools/call` is legal — each request is a self-contained POST authenticated by
  a 128-bit capability token compared in constant time. See
  [docs/DESIGN.md](docs/DESIGN.md).
- **Platform-free core.** `src/core/` uses no Workers or DOM APIs and no runtime
  deps, so the classifier and ring buffer are unit-tested under plain Node; the
  Worker and its two Durable Objects are the only Cloudflare-aware files.
- **Tested and gated.** ~250 tests (Vitest for core + server, Playwright for the
  page) run in CI beside CodeQL (`security-extended`), OpenSSF Scorecard,
  dependency review, and a Claude first-pass review on every PR — with the
  zero-runtime-dependency rule enforced mechanically at the gate, not just in
  prose. See [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md) for the CI and
  branch-protection setup.

## Privacy in one breath

It's your Cloudflare account, your instance, your data. The author of this
repo runs no server and receives nothing, there is no shared backend to
leak from. There are deliberately no accounts, no analytics, no GPS, and no
fall or health detection anywhere in this repo. A session holds at most 30
minutes of frames and erases itself after 60 idle minutes with no phone
activity and no Claude activity; hitting **End & erase** on either device
wipes it immediately. The full teardown, session, connector, Worker, and
Wrangler's account access, is
[QUICKSTART § Stop it and erase everything](QUICKSTART.md#6-stop-it-and-erase-everything). 
The one data flow that does leave your instance:
whatever a tool returns goes to your AI provider the moment you ask a
question, exactly like any other message in that chat. One caveat worth stating
up front: the pairing flow lets *any* phone join, so if you let someone else's
device stream to your instance, you become the data controller for their data, 
[PRIVACY.md](PRIVACY.md) explains when that happens and what it means. The full
detail, including retention and the GDPR/CCPA analysis, lives in
[PRIVACY.md](PRIVACY.md), and a
[data-protection record](docs/DATA_PROTECTION.md).

## Platform notes

- **iOS** only grants motion-sensor access from a real tap, which is why
  step 3 above asks for one. If you'd previously denied it, re-enable it at
  Settings → Safari → Motion & Orientation Access.
- **Android** devices vary in whether they expose an absolute (compass)
  heading or only one relative to wherever tracking started, check
  `headingAbsolute` in the response rather than assuming either way.
- Keep the phone's **screen on** while streaming. The page requests a wake
  lock where the browser supports one, but on browsers that don't, turn off
  auto-lock yourself for the session.

## Relation to Proprioceptor

proprioceptor-lite is the friction-free public probe of a larger,
local-first project called Proprioceptor: a full sensor-fusion stack (Go,
Python, Kotlin, and C++ components, plus native phone apps) that adds
precise location and deeper motion inference under strict, explicit
consent. That project isn't public yet. This repo shares its name and its
commitment to honest, null-safe output, but none of its code.

## Development

```sh
npm run typecheck   # tsc -b, project references
npm run test        # vitest, core + server (no network, no DB)
npm run test:web    # playwright against the served page (chromium)
npm run dev         # wrangler dev
npm run deploy      # wrangler deploy
```

CI (`.github/workflows/ci.yml`) runs the same gates: `typecheck` + `test` in
one job, `test:web` in another against a headless Chromium.

## Credits

- Cloudflare Workers, the platform this runs on.
- The web Device Orientation and Motion APIs (W3C/WHATWG specifications,
  documented by MDN), the sensor data this app reads.
- Published gait-analysis literature, the walking/running cadence bands
  in `docs/CONTRACTS.md`.
- The [Model Context Protocol](https://modelcontextprotocol.io)
  specification (Anthropic), the tool-calling surface Claude uses.

## License

MIT — see [LICENSE](LICENSE).
