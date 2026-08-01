# Quickstart

The two-minute path from zero to Claude reading your phone's motion
sensors, and the teardown at the end, expanded just enough that each
step is unambiguous. For the
how/why, see [README.md](README.md); for wire-level detail, see
[docs/CONTRACTS.md](docs/CONTRACTS.md) and [docs/DESIGN.md](docs/DESIGN.md).

## 0. Before you start

**Node.js 20 or newer** (an LTS — 22 or 24 — is recommended) and a **free
Cloudflare account**. Nothing else needs installing: Wrangler runs through
`npx`, there are no runtime dependencies, and nothing compiles native code.
Full per-platform install instructions are in
[README.md § Requirements](README.md#requirements). Check with:

```sh
node -v   # must print v20.x or newer
```

If that command itself errors, fix it first — see
[Troubleshooting setup](#troubleshooting-setup) below.

## 1. Deploy your own instance

You need a free Cloudflare account — no credit card, no paid plan.

```sh
npm create cloudflare@latest -- --template mda-silvribeiro/proprioceptor-lite
```

or clone this repository yourself and run:

```sh
npm install
npx wrangler@4 deploy
```

Either way, `wrangler` prints your instance's URL when it finishes —
something like `https://proprioceptor-lite.<you>.workers.dev`. That's
yours; nobody else's traffic touches it.

## 2. Start a session (desktop)

Open that URL on a **desktop** browser and click **Start a session**. The
page shows an MCP connector URL and a 6-digit pairing code. Leave this tab
open — it's also how you'll hit **End & erase** later.

## 3. Join from your phone

Open the same URL on your **phone**, enter the 6-digit code, and tap
**Start**. The tap matters: iOS only grants motion-sensor access from a
real user gesture, so a page that tried to start streaming on its own
would just get silently denied. Leave this tab open too, and keep the
screen on while it's streaming.

## 4. Add the connector in claude.ai

**Settings → Connectors → Add custom connector**, then paste the MCP
connector URL from step 2. Name it whatever you like.

## 5. Ask Claude

- "What's my current motion state?"
- "Which way am I facing?"
- "Summarize my last few minutes of movement."

## 6. Stop it and erase everything

The short version: hit **End & erase** on either tab. The session and every
frame in it are wiped immediately (`storage.deleteAll()` — there are no
backups anywhere in this design). If you just close the tabs instead, the
same wipe happens on its own after 60 minutes with no phone activity and no
Claude activity, and the buffer never held more than the last 30 minutes to
begin with.

For a full purge, nothing left on any device or account:

1. **Session data.** **End & erase** on the phone or the desktop tab, or
   wait out the 60-minute idle self-erase.
2. **Phone.** Close the tab. The page sets no cookies and uses no local
   storage, so there is nothing else to clear. If you granted iOS motion
   access and want that gone too: Settings → Safari → Motion & Orientation
   Access → off.
3. **Desktop.** Close the tab. Same story — nothing stored.
4. **claude.ai.** Remove the connector: **Settings → Connectors → your
   connector → Remove**. One honest caveat: readings Claude already quoted
   into a conversation live on in that chat like any other message — delete
   the conversation if you want those gone as well.
5. **Cloudflare.** Delete the Worker, and with it both Durable Objects and
   their stored data: `npx wrangler@4 delete` from the repo directory (or
   dash → Workers & Pages → proprioceptor-lite → Settings → Delete). Your
   `*.workers.dev` subdomain is just a name on the account and holds no
   data — leave it, or change it in the dash.
6. **This computer.** `npx wrangler@4 logout` revokes the OAuth grant
   Wrangler stored at deploy time. Delete the cloned repo folder if you are
   fully done — it never contains session data or secrets.

Erased means erased: the Worker logs no frame values and there are no
analytics to purge. What Cloudflare retains at the platform level (request
metadata, not frame contents) is covered in [PRIVACY.md](PRIVACY.md).

## Troubleshooting setup

Failures *before* the app runs are almost always the local Node installation,
not this project. `npm install` runs `node`, so a `node` that cannot start
aborts the install before a single package is fetched.

| Symptom | Cause and fix |
|---|---|
| `dyld: Library not loaded: …libllhttp.9.x.dylib` … `Referenced from: /opt/homebrew/Cellar/node/…` (macOS) | Homebrew upgraded the `llhttp` library but did not relink `node` against it, so the binary points at a `.dylib` that no longer exists. Node is broken system-wide, not just here. Fix with `brew reinstall node`, or move off the Homebrew formula entirely with fnm: `brew install fnm`, hook it into your shell once (`echo 'eval "$(fnm env --use-on-cd)"' >> ~/.zshrc`, then open a new terminal), and `fnm install --lts`. Full steps: [README § Installing Node](README.md#installing-node). |
| `dyld: Library not loaded: …` naming some other library (macOS) | Same class of problem after any `brew upgrade`. `brew reinstall node`, or `brew doctor` if several formulae are affected. |
| `node: command not found` | Node isn't installed or isn't on `PATH`. See [README.md § Requirements](README.md#requirements). If you use a version manager, open a new shell (or `nvm use --lts` / `fnm use lts-latest`) so it can inject `PATH`, and make sure its one-time shell setup is in your profile (for fnm: `eval "$(fnm env --use-on-cd)"` in `~/.zshrc`). |
| `npm ERR! engine Unsupported engine` / `required: { node: '>=20' }` | Node is older than this project's floor. Install an LTS and re-run. `node -v` tells you what you actually have. |
| `EACCES` / permission errors during `npm install` | You are on a system-wide Node and npm wants to write where your user cannot. Do **not** re-run with `sudo`; switch to a version manager, which installs under your home directory. |
| Wrangler asks you to log in, or the deploy 403s | Expected on first use: `npx wrangler@4 login` opens a browser to authorize your Cloudflare account. |
| `npm error could not determine executable to run` | Usually a partially-written npm cache. `npm cache clean --force`, then retry. |

None of the above are caused by the repository, it has zero runtime
dependencies and nothing that compiles. If `node -v` prints a version ≥ 20 and
`npm install` still fails, that's worth
[an issue](https://github.com/mda-silvribeiro/proprioceptor-lite/issues/new).

## When something doesn't work

| Symptom | Fix |
|---|---|
| Pairing code says expired | Codes last 5 minutes. Reload the desktop tab and click **Start a session** again to mint a new one. |
| Sensors denied on iOS | Settings → Safari → Motion & Orientation Access → turn it on, then reload the phone tab and tap **Start** again. |
| Connector not listed / claude.ai rejects the URL | Re-check the URL you pasted, it must end in `/mcp/<token>`, copied in full, nothing truncated. |
| Adding the connector fails with "Couldn't register with …'s sign-in service" | There is no sign-in service to register with, this server uses no OAuth, so do **not** add an OAuth Client ID. claude.ai says this when its OAuth probe of the server goes wrong, which has two causes. A deployed Worker from before `/.well-known/*` answered `404` ([CONTRACTS § HTTP endpoints](docs/CONTRACTS.md#http-endpoints)) serves the probe the app page, which reads as "this server has OAuth" — `git pull` and `npx wrangler@4 deploy` to update yours. And a dead MCP URL, expired session, truncated paste, sends claude.ai down the same path: start a fresh session and paste the full `/mcp/<token>` URL right away. |
| Session expired / tools return nothing | Sessions are ephemeral by design: a 30-minute buffer, erased after 60 idle minutes either side. Start a new session (step 2) and reconnect. |

Everything else, architecture, the activity classifier, privacy, and the
security tradeoffs, lives in [README.md](README.md),
[docs/DESIGN.md](docs/DESIGN.md), and [PRIVACY.md](PRIVACY.md).
