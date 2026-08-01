/**
 * Entry point: role detection, routing, and the two state machines.
 *
 * One page serves both ends of a session. The URL decides which:
 *   `/`            → landing (start a session, or claim a code)
 *   `/s/<token>`   → this device is the sensor
 * The Worker serves index.html for `/s/<token>` via the SPA fallback, so the
 * phone can reload, share, or come back to that link and still land here.
 *
 * The desktop's token lives in memory only. Nothing about a session is written
 * to storage, so closing the tab is a real end — and a reload is a real restart.
 */

import * as api from "./api.js";
import * as ui from "./ui.js";
import { MotionStreamer } from "./sensors.js";

/** @typedef {import("./api.js").Status} Status */
/** @typedef {import("./sensors.js").StreamState} StreamState */

/** 22 chars of base64url — docs/CONTRACTS.md § Identity and pairing. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SESSION_PATH = /^\/s\/([^/]+)\/?$/;
/** The desktop polls at the contract's ceiling; the phone is gentler. */
const DESKTOP_POLL_MS = 1000;
const PHONE_POLL_MS = 2000;

/** @typedef {"landing"|"desktop"|"phone"} Role */

/** @type {{role: Role, token: string|null, codeExpiresAt: number|null}} */
const session = { role: "landing", token: null, codeExpiresAt: null };

/** Set after a successful claim, so the `#claimed` fallback route can work. */
let claimedToken = /** @type {string|null} */ (null);
/** @type {MotionStreamer|null} */
let streamer = null;
/** @type {number|null} */
let pollTimer = null;
/** @type {number|null} */
let countdownTimer = null;
/** @type {number|null} */
let copyResetTimer = null;
/** @type {number|null} */
let startCooldownTimer = null;
/**
 * Bumped by every startPolling/stopPolling, so a request still in flight when
 * polling was cancelled can't schedule the next one, otherwise ending a session
 * races a status poll and the "erased" message gets overwritten by "gone".
 */
let pollGeneration = 0;
let pollFailures = 0;
let claiming = false;
/** Last announced status sentence, to keep the live region from repeating. */
let lastAnnouncement = "";
/** @type {Status|null} */
let lastStatus = null;

const dom = {
  main: ui.html("main"),
  banner: ui.html("banner"),
  bannerText: ui.html("banner-text"),
  bannerDismiss: ui.element("banner-dismiss", HTMLButtonElement),

  viewLanding: ui.html("view-landing"),
  viewDesktop: ui.html("view-desktop"),
  viewPhone: ui.html("view-phone"),
  headingLanding: ui.html("landing-h"),
  headingDesktop: ui.html("desktop-h"),
  headingPhone: ui.html("phone-h"),

  btnStart: ui.element("btn-start", HTMLButtonElement),
  startMsg: ui.html("start-msg"),
  formClaim: ui.element("form-claim", HTMLFormElement),
  codeInput: ui.element("code", HTMLInputElement),
  btnClaim: ui.element("btn-claim", HTMLButtonElement),
  claimMsg: ui.html("claim-msg"),

  siteHost: ui.html("site-host"),
  codeDigits: ui.html("code-digits"),
  codeCountdown: ui.html("code-countdown"),
  connectorUrl: ui.html("connector-url"),
  btnCopy: ui.element("btn-copy", HTMLButtonElement),
  btnCopyLabel: ui.html("btn-copy-label"),
  copyMsg: ui.html("copy-msg"),
  desktopAnnounce: ui.html("d-announce"),
  endDesktop: ui.html("end-desktop"),

  gate: ui.html("gate"),
  gateMsg: ui.html("gate-msg"),
  gateError: ui.html("gate-error"),
  btnSensors: ui.element("btn-sensors", HTMLButtonElement),
  btnGateHome: ui.element("btn-gate-home", HTMLButtonElement),
  live: ui.html("live"),
  liveHeading: ui.html("live-h"),
  wakeHint: ui.html("wake-hint"),
  endPhone: ui.html("end-phone"),
  phoneMcp: ui.html("v-mcp"),
};

/** @type {ui.DesktopStatusView} */
const desktopStatusView = {
  chip: ui.html("d-chip"),
  phone: ui.html("d-phone"),
  rate: ui.html("d-rate"),
  fresh: ui.html("d-fresh"),
  mcp: ui.html("d-mcp"),
  age: ui.html("d-age"),
  ttl: ui.html("d-ttl"),
};

/** @type {ui.PhoneView} */
const phoneView = {
  chip: ui.html("stream-chip"),
  heading: ui.html("v-heading"),
  headingLabel: ui.html("l-heading"),
  tilt: ui.html("v-tilt"),
  motionChip: ui.html("motion-chip"),
  aMag: ui.html("v-amag"),
  rate: ui.html("v-rate"),
  sent: ui.html("v-sent"),
  dropped: ui.html("v-dropped"),
  lastPost: ui.html("v-lastpost"),
  absolute: ui.html("v-absolute"),
  message: ui.html("stream-msg"),
  compass: ui.createCompass(
    ui.element("compass", SVGSVGElement),
    ui.element("needle", SVGGElement),
  ),
  level: ui.createLevel(ui.element("level", SVGSVGElement), ui.element("bubble", SVGCircleElement)),
};

/*  banner  */

/** @param {string} message */
function showBanner(message) {
  ui.setText(dom.bannerText, message);
  ui.setHidden(dom.banner, false);
}

function hideBanner() {
  ui.setHidden(dom.banner, true);
  ui.setText(dom.bannerText, "");
  // The dismiss button just vanished from the tab order; park focus somewhere
  // real instead of dropping it on <body>.
  dom.main.focus();
}

/*  views  */

/**
 * @param {Role} role
 * @param {boolean} moveFocus
 */
function showView(role, moveFocus) {
  session.role = role;
  ui.setHidden(dom.viewLanding, role !== "landing");
  ui.setHidden(dom.viewDesktop, role !== "desktop");
  ui.setHidden(dom.viewPhone, role !== "phone");
  if (!moveFocus) return;
  const heading =
    role === "landing"
      ? dom.headingLanding
      : role === "desktop"
        ? dom.headingDesktop
        : dom.headingPhone;
  heading.focus();
}

/**
 * Tear the session down locally and go home. Used for "gone", for erase, and
 * for a bad link.
 * @param {string|null} message
 */
function resetToLanding(message) {
  stopPolling();
  stopCountdown();
  if (startCooldownTimer !== null) window.clearInterval(startCooldownTimer);
  startCooldownTimer = null;
  if (streamer !== null) {
    streamer.stop();
    streamer = null;
  }
  session.token = null;
  session.codeExpiresAt = null;
  claimedToken = null;
  lastStatus = null;
  lastAnnouncement = "";
  ui.renderDesktopStatus(desktopStatusView, null, false);
  ui.setText(dom.codeDigits, "——————");
  ui.setText(dom.connectorUrl, ui.NO_VALUE);
  ui.setText(dom.startMsg, "");
  dom.btnStart.disabled = false;
  if (location.pathname !== "/" || location.hash !== "") {
    history.pushState(null, "", "/");
  }
  // Focus always moves: whatever the user just pressed is inside the view that
  // is now hidden, and losing focus to <body> is a dead end for the keyboard.
  showView("landing", true);
  if (message !== null) showBanner(message);
}

/*  desktop: create + display a session  */

async function startSession() {
  dom.btnStart.disabled = true;
  hideBanner();
  ui.setText(dom.startMsg, "Creating a session…");
  try {
    const info = await api.createSession();
    session.token = info.token;
    session.codeExpiresAt = Date.now() + info.expiresInS * 1000;
    ui.setText(dom.startMsg, "");
    renderPairing(info);
    showView("desktop", true);
    startPolling(DESKTOP_POLL_MS);
    startCountdown();
  } catch (error) {
    const failure = asApiError(error);
    if (failure.kind === "rate-limited" && failure.retryAfterS !== null) {
      cooldownStartButton(failure.retryAfterS);
      return;
    }
    ui.setText(dom.startMsg, failure.message);
    dom.btnStart.disabled = false;
  }
}

/**
 * The session-create limit is global (10 per 10 min), so this is a plausible
 * thing for a real user to hit. Show the wait instead of a dead button.
 * @param {number} seconds
 */
function cooldownStartButton(seconds) {
  let remaining = seconds;
  const tick = () => {
    if (remaining <= 0) {
      if (startCooldownTimer !== null) window.clearInterval(startCooldownTimer);
      startCooldownTimer = null;
      dom.btnStart.disabled = false;
      ui.setText(dom.startMsg, "Ready to try again.");
      return;
    }
    ui.setText(
      dom.startMsg,
      `This instance is at its limit of new sessions — paused, resuming in ${remaining} s.`,
    );
    remaining -= 1;
  };
  tick();
  if (startCooldownTimer !== null) window.clearInterval(startCooldownTimer);
  startCooldownTimer = window.setInterval(tick, 1000);
}

/** @param {import("./api.js").SessionInfo} info */
function renderPairing(info) {
  const url = api.connectorUrl(location.origin, info.mcpPath);
  ui.setText(dom.siteHost, location.host);
  ui.setText(dom.codeDigits, info.code);
  dom.codeDigits.setAttribute("aria-label", `Pairing code ${ui.spellCode(info.code)}`);
  ui.setText(dom.connectorUrl, url);
  ui.setText(dom.btnCopyLabel, "Copy URL");
  ui.setText(dom.copyMsg, "");
  ui.renderDesktopStatus(desktopStatusView, null, false);
  buildEndBlock(dom.endDesktop, "Erases the buffer and this session's token on the server at once.");
}

function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (session.codeExpiresAt === null) return;
    const remaining = (session.codeExpiresAt - Date.now()) / 1000;
    if (remaining <= 0) {
      ui.setText(dom.codeCountdown, "0:00");
      ui.setText(dom.codeDigits, "expired");
      dom.codeDigits.setAttribute("aria-label", "The pairing code has expired");
      showBanner(
        "The pairing code expired. This session is still alive for Claude, but no new phone can pair with it — start a new session to get a fresh code.",
      );
      stopCountdown();
      return;
    }
    ui.setText(dom.codeCountdown, ui.formatClock(remaining));
  };
  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

function stopCountdown() {
  if (countdownTimer !== null) window.clearInterval(countdownTimer);
  countdownTimer = null;
}

async function copyConnectorUrl() {
  const url = dom.connectorUrl.textContent ?? "";
  if (url === "" || url === ui.NO_VALUE) return;
  const copied = await ui.copyToClipboard(url);
  ui.setText(dom.btnCopyLabel, copied ? "Copied" : "Copy URL");
  ui.setText(
    dom.copyMsg,
    copied ? "Connector URL copied to the clipboard." : "Couldn't copy — select the URL and copy it.",
  );
  if (copyResetTimer !== null) window.clearTimeout(copyResetTimer);
  copyResetTimer = window.setTimeout(() => {
    ui.setText(dom.btnCopyLabel, "Copy URL");
    ui.setText(dom.copyMsg, "");
  }, 4000);
}

/*  phone: claim a code  */

async function claim() {
  if (claiming) return;
  const code = dom.codeInput.value.replace(/\D+/g, "");
  if (code.length !== 6) {
    dom.codeInput.setAttribute("aria-invalid", "true");
    ui.setText(dom.claimMsg, "A pairing code is exactly six digits.");
    return;
  }
  claiming = true;
  dom.btnClaim.disabled = true;
  dom.codeInput.removeAttribute("aria-invalid");
  ui.setText(dom.claimMsg, "Checking that code…");
  try {
    const token = await api.claimCode(code);
    claimedToken = token;
    session.token = token;
    ui.setText(dom.claimMsg, "");
    dom.codeInput.value = "";
    goToPhoneView(token, true);
  } catch (error) {
    const failure = asApiError(error);
    dom.codeInput.setAttribute("aria-invalid", "true");
    ui.setText(dom.claimMsg, failure.message);
    dom.codeInput.select();
  } finally {
    claiming = false;
    dom.btnClaim.disabled = false;
  }
}

/**
 * @param {string} token
 * @param {boolean} pushHistory
 */
function goToPhoneView(token, pushHistory) {
  session.token = token;
  if (pushHistory) {
    // A real path (not a fragment) so the phone can reload or re-open the link;
    // the Worker's SPA fallback serves this same page for it.
    try {
      history.pushState(null, "", `/s/${token}`);
    } catch {
      // Some embedded webviews refuse pushState; the fragment keeps the role.
      location.hash = "#claimed";
    }
  }
  resetPhoneView();
  showView("phone", true);
  startPolling(PHONE_POLL_MS);
  buildEndBlock(dom.endPhone, "Stops streaming and erases the buffer at once.");
}

function resetPhoneView() {
  ui.setHidden(dom.gate, false);
  ui.setHidden(dom.live, true);
  ui.setHidden(dom.gateError, true);
  ui.setHidden(dom.btnGateHome, true);
  ui.setText(dom.gateMsg, "");
  dom.btnSensors.disabled = false;
  ui.setText(dom.btnSensors, "Start streaming");
}

/*  phone: streaming  */

function startStreaming() {
  const token = session.token;
  if (token === null) return;
  dom.btnSensors.disabled = true;
  ui.setHidden(dom.gateError, true);
  ui.setText(dom.gateMsg, "Asking this device for motion access…");

  streamer = new MotionStreamer({
    token,
    send: api.postFrames,
    onState: onStreamState,
    onSessionGone: () => resetToLanding(api.SESSION_GONE_MESSAGE),
  });

  // No `await` before this call: iOS only grants motion access while the click
  // that triggered it is still the current task's user activation.
  void streamer.start().then((started) => {
    if (started) {
      ui.setHidden(dom.gate, true);
      ui.setHidden(dom.live, false);
      // Disabling the Start button dropped focus to <body>; hiding the whole
      // gate would strand keyboard/AT users there, so move focus onto the live
      // panel's heading (tabindex=-1) that just replaced it.
      dom.liveHeading.focus();
      return;
    }
    // Every failure keeps one obvious next action on screen: try again, or go
    // back and start over. No dead ends, and focus lands on that next action
    // rather than on <body>, where disabling the button left it.
    const unsupported = streamer?.phase === "unsupported";
    dom.btnSensors.disabled = unsupported;
    ui.setText(dom.btnSensors, unsupported ? "Sensors unavailable" : "Try again");
    ui.setText(dom.gateMsg, "");
    const message = streamer?.state.message;
    if (message !== null && message !== undefined) {
      ui.setText(dom.gateError, message);
      ui.setHidden(dom.gateError, false);
    }
    ui.setHidden(dom.btnGateHome, false);
    (unsupported ? dom.btnGateHome : dom.btnSensors).focus();
  });
}

/** @param {StreamState} state */
function onStreamState(state) {
  ui.renderStreamState(phoneView, state);
  ui.setText(dom.wakeHint, ui.describeWakeLock(state));
}

/*  status polling (both roles)  */

/** @param {number} intervalMs */
function startPolling(intervalMs) {
  stopPolling();
  const generation = ++pollGeneration;
  const run = async () => {
    const token = session.token;
    if (token === null || generation !== pollGeneration) return;
    let delay = intervalMs;
    try {
      const status = await api.getStatus(token);
      if (generation !== pollGeneration) return;
      lastStatus = status;
      pollFailures = 0;
      renderStatus(status, false);
    } catch (error) {
      if (generation !== pollGeneration) return;
      const failure = asApiError(error);
      if (failure.kind === "gone") {
        resetToLanding(api.SESSION_GONE_MESSAGE);
        return;
      }
      if (failure.kind === "rate-limited" && failure.retryAfterS !== null) {
        delay = failure.retryAfterS * 1000;
      } else {
        pollFailures += 1;
        delay = Math.max(intervalMs, api.backoffDelayMs(pollFailures));
      }
      renderStatus(lastStatus, true);
    }
    pollTimer = window.setTimeout(() => void run(), delay);
  };
  void run();
}

function stopPolling() {
  pollGeneration += 1;
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
  pollFailures = 0;
}

/**
 * @param {Status|null} status
 * @param {boolean} stale
 */
function renderStatus(status, stale) {
  if (session.role === "desktop") {
    ui.renderDesktopStatus(desktopStatusView, status, stale);
    announceDesktop(status, stale);
    return;
  }
  if (session.role === "phone") {
    ui.setText(dom.phoneMcp, status === null ? ui.NO_VALUE : ui.formatMcp(status.mcp));
  }
}

/**
 * The read-out table updates every second, which is far too chatty for a live
 * region, so only the transitions that matter are announced.
 * @param {Status|null} status
 * @param {boolean} stale
 */
function announceDesktop(status, stale) {
  let sentence = "";
  if (stale) {
    sentence = "Lost contact with the session — retrying.";
  } else if (status === null) {
    sentence = "";
  } else if (!status.phone.streaming) {
    sentence = "Waiting for a phone to pair and start streaming.";
  } else {
    sentence = `Phone connected, streaming at ${ui.formatHz(status.phone.rateHz)}.`;
    if (status.mcp.totalCalls > 0) {
      sentence += ` Claude has made ${status.mcp.totalCalls} tool ${
        status.mcp.totalCalls === 1 ? "call" : "calls"
      }.`;
    }
  }
  if (sentence !== lastAnnouncement) {
    lastAnnouncement = sentence;
    ui.setText(dom.desktopAnnounce, sentence);
  }
}

/*  end & erase (both roles)  */

/**
 * Built in JS rather than markup so the confirm step can't be reached by a
 * stray click, and so both roles share one implementation.
 * @param {HTMLElement} container
 * @param {string} note
 */
function buildEndBlock(container, note) {
  container.replaceChildren();

  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-danger";
  button.textContent = "End & erase";

  const hint = document.createElement("p");
  hint.className = "end-note";
  hint.textContent = note;

  const confirmRow = document.createElement("div");
  confirmRow.className = "end-confirm";
  confirmRow.hidden = true;

  const question = document.createElement("p");
  question.className = "end-note";
  question.textContent = "Erase this session now? This can't be undone.";

  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "btn btn-danger";
  yes.textContent = "Yes, erase";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-quiet";
  cancel.textContent = "Cancel";

  const status = document.createElement("p");
  status.className = "msg";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  button.addEventListener("click", () => {
    button.hidden = true;
    confirmRow.hidden = false;
    yes.focus();
  });
  cancel.addEventListener("click", () => {
    confirmRow.hidden = true;
    button.hidden = false;
    ui.setText(status, "");
    button.focus();
  });
  yes.addEventListener("click", () => {
    yes.disabled = true;
    cancel.disabled = true;
    ui.setText(status, "Erasing…");
    void endAndErase(status, () => {
      yes.disabled = false;
      cancel.disabled = false;
    });
  });

  confirmRow.append(question, yes, cancel);
  container.append(button, hint, confirmRow, status);
}

/**
 * @param {HTMLElement} status
 * @param {() => void} onFailure
 */
async function endAndErase(status, onFailure) {
  const token = session.token;
  if (token === null) return;
  if (streamer !== null) {
    streamer.stop();
    streamer = null;
  }
  stopPolling();
  try {
    await api.endSession(token);
    resetToLanding("Session ended and erased. Nothing was kept.");
  } catch (error) {
    const failure = asApiError(error);
    ui.setText(status, `${failure.message} The session may still be live — try again.`);
    onFailure();
  }
}

/*  routing  */

/** @param {boolean} moveFocus */
function applyRoute(moveFocus) {
  const match = SESSION_PATH.exec(location.pathname);
  if (match !== null) {
    const token = match[1] ?? "";
    if (!TOKEN_PATTERN.test(token)) {
      // Don't say "bad token" — the server refuses to distinguish that from an
      // expired session, and neither do we.
      resetToLanding(api.SESSION_GONE_MESSAGE);
      return;
    }
    goToPhoneView(token, false);
    return;
  }
  if (location.hash === "#claimed" && claimedToken !== null) {
    goToPhoneView(claimedToken, false);
    return;
  }
  if (session.token !== null && session.role === "desktop") {
    showView("desktop", moveFocus);
    return;
  }
  showView("landing", moveFocus);
}

/*  wiring  */

dom.btnStart.addEventListener("click", () => void startSession());
dom.btnCopy.addEventListener("click", () => void copyConnectorUrl());
dom.bannerDismiss.addEventListener("click", hideBanner);
// `form-action 'none'` in the CSP would block a real submission; this form has
// always been a keyboard affordance, never a navigation.
dom.formClaim.addEventListener("submit", (event) => {
  event.preventDefault();
  void claim();
});
dom.codeInput.addEventListener("input", () => {
  const digits = dom.codeInput.value.replace(/\D+/g, "").slice(0, 6);
  if (digits !== dom.codeInput.value) dom.codeInput.value = digits;
  if (digits.length === 6) void claim();
});
dom.btnSensors.addEventListener("click", startStreaming);
dom.btnGateHome.addEventListener("click", () => resetToLanding(null));
window.addEventListener("popstate", () => {
  if (streamer !== null) {
    streamer.stop();
    streamer = null;
  }
  stopPolling();
  applyRoute(false);
});

ui.setText(dom.siteHost, location.host);
ui.renderDesktopStatus(desktopStatusView, null, false);
applyRoute(false);

/**
 * @param {unknown} error
 * @returns {api.ApiError}
 */
function asApiError(error) {
  if (error instanceof api.ApiError) return error;
  return new api.ApiError("network", "Something went wrong. Try again.");
}
