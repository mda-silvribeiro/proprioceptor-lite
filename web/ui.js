/**
 * Rendering helpers. Everything here writes `textContent` or SVG geometry
 * attributes, never `innerHTML`, and never a `style` attribute (the CSP has no
 * `unsafe-inline`, and the habit is worth keeping anyway).
 *
 * Placeholders are an em dash, not `0`: an empty read-out has to look empty.
 */

/** @typedef {import("./api.js").Status} Status */
/** @typedef {import("./sensors.js").StreamState} StreamState */

/** Shown wherever a value is genuinely unknown. */
export const NO_VALUE = "—";

/**
 * @template {Element} T
 * @param {string} id
 * @param {{ new (): T, name?: string }} ctor
 * @returns {T}
 */
export function element(id, ctor) {
  const node = document.querySelector(`#${id}`);
  if (!(node instanceof ctor)) {
    throw new Error(`#${id} is missing or is not a ${ctor.name ?? "the expected element"}`);
  }
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
export function html(id) {
  return element(id, HTMLElement);
}

/**
 * @param {Element} node
 * @param {string} value
 */
export function setText(node, value) {
  node.textContent = value;
}

/**
 * @param {Element} node
 * @param {boolean} hidden
 */
export function setHidden(node, hidden) {
  node.toggleAttribute("hidden", hidden);
}

/**
 * @param {number|null} value
 * @param {number} digits
 * @returns {string}
 */
export function formatDegrees(value, digits = 0) {
  return value === null ? NO_VALUE : `${value.toFixed(digits)}°`;
}

/**
 * Explicit sign, so a pitch of -0.4 never reads as a bare "0".
 * @param {number|null} value
 * @param {number} digits
 * @returns {string}
 */
export function formatSignedDegrees(value, digits = 0) {
  if (value === null) return NO_VALUE;
  const rounded = Number(value.toFixed(digits));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toFixed(digits)}°`;
}

/**
 * @param {number|null} hz
 * @returns {string}
 */
export function formatHz(hz) {
  return hz === null ? NO_VALUE : `${hz.toFixed(1)} Hz`;
}

/**
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatAge(seconds) {
  if (seconds === null) return NO_VALUE;
  if (seconds < 10) return `${seconds.toFixed(1)} s ago`;
  if (seconds < 90) return `${Math.round(seconds)} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

/**
 * m:ss, for countdowns.
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return "—:——";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** @typedef {"neutral"|"live"|"good"|"warn"|"bad"} ChipTone */

/**
 * @param {HTMLElement} node
 * @param {string} label
 * @param {ChipTone} tone
 */
export function setChip(node, label, tone) {
  node.textContent = label;
  node.classList.remove("chip-live", "chip-good", "chip-warn", "chip-bad");
  if (tone !== "neutral") node.classList.add(`chip-${tone}`);
}

/* ── dials */

const DIAL_CENTER = 60;
/** Full bubble deflection at this much tilt. */
const LEVEL_SPAN_DEG = 45;
/** Keeps the r=12 bubble inside the r=53 face. */
const LEVEL_RADIUS = 38;

/**
 * Sets an attribute only when it actually changed. Keeps assistive technology
 * from re-reading an unchanged label five times a second, and keeps the
 * compositor from being handed no-op transforms.
 * @param {Element} node
 * @param {string} name
 * @param {string} value
 */
function setAttributeIfChanged(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/**
 * North-up compass: the rose is fixed and the needle turns to the bearing.
 * A positive SVG rotation is clockwise, which is also how bearings count, so the
 * angle goes in unmodified — and it goes in as a `transform`, so the needle is
 * composited rather than re-laid-out.
 * @param {SVGSVGElement} svg
 * @param {SVGGElement} needle
 * @returns {{set: (headingDeg: number|null, absolute: boolean) => void}}
 */
export function createCompass(svg, needle) {
  return {
    set(headingDeg, absolute) {
      // No heading → no needle. A needle parked at north would be a claim.
      svg.classList.toggle("dial-nodata", headingDeg === null);
      if (headingDeg === null) {
        setAttributeIfChanged(svg, "aria-label", "Compass: no heading yet");
        return;
      }
      setAttributeIfChanged(
        needle,
        "transform",
        `rotate(${headingDeg.toFixed(1)} ${DIAL_CENTER} ${DIAL_CENTER})`,
      );
      setAttributeIfChanged(
        svg,
        "aria-label",
        `Compass: heading ${headingDeg.toFixed(0)} degrees, ${
          absolute ? "compass-referenced" : "relative to where tracking started"
        }`,
      );
    },
  };
}

/**
 * Spirit level: the bubble rises to the high side. Positive gamma (roll) puts the
 * right edge down, so the bubble goes left; positive beta (pitch) lifts the top
 * edge, so the bubble goes up, a *smaller* SVG y. Both axes are therefore
 * negated. The deflection is clamped as a vector, so the bubble travels a disc
 * rather than a square, and it moves by `transform` rather than cx/cy so that
 * nothing invalidates layout.
 * @param {SVGSVGElement} svg
 * @param {SVGCircleElement} bubble
 * @returns {{set: (pitchDeg: number|null, rollDeg: number|null) => void}}
 */
export function createLevel(svg, bubble) {
  return {
    set(pitchDeg, rollDeg) {
      // One axis alone cannot place a bubble; showing it half-informed would
      // imply the missing axis is zero.
      const known = pitchDeg !== null && rollDeg !== null;
      svg.classList.toggle("dial-nodata", !known);
      if (!known || pitchDeg === null || rollDeg === null) {
        setAttributeIfChanged(svg, "aria-label", "Bubble level: no tilt reading yet");
        return;
      }
      const scale = LEVEL_RADIUS / LEVEL_SPAN_DEG;
      let dx = -rollDeg * scale;
      let dy = -pitchDeg * scale;
      const length = Math.hypot(dx, dy);
      if (length > LEVEL_RADIUS) {
        dx = (dx * LEVEL_RADIUS) / length;
        dy = (dy * LEVEL_RADIUS) / length;
      }
      setAttributeIfChanged(bubble, "transform", `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
      setAttributeIfChanged(
        svg,
        "aria-label",
        `Bubble level: pitch ${formatSignedDegrees(pitchDeg)}, roll ${formatSignedDegrees(rollDeg)}`,
      );
    },
  };
}

/* status rendering  */

/**
 * @param {Status["mcp"]} mcp
 * @returns {string}
 */
export function formatMcp(mcp) {
  if (mcp.totalCalls === 0) return "none yet";
  const plural = mcp.totalCalls === 1 ? "call" : "calls";
  if (mcp.lastCallAgeS === null) return `${mcp.totalCalls} ${plural}`;
  return `${mcp.totalCalls} ${plural}, last ${formatAge(mcp.lastCallAgeS)}`;
}

/**
 * @typedef {object} DesktopStatusView
 * @property {HTMLElement} chip
 * @property {HTMLElement} phone
 * @property {HTMLElement} rate
 * @property {HTMLElement} fresh
 * @property {HTMLElement} mcp
 * @property {HTMLElement} age
 * @property {HTMLElement} ttl
 */

/**
 * Three designed states, not two: no status yet (empty), a status (live or
 * quiet), and a status we could not fetch (error), which keeps the last known
 * numbers on screen but says plainly that they are stale.
 * @param {DesktopStatusView} view
 * @param {Status|null} status
 * @param {boolean} stale  true when the last poll failed
 */
export function renderDesktopStatus(view, status, stale) {
  if (stale) {
    setChip(view.chip, "offline", "bad");
  } else if (status === null) {
    setChip(view.chip, "waiting", "neutral");
  } else {
    setChip(
      view.chip,
      status.phone.streaming ? "live" : "quiet",
      status.phone.streaming ? "live" : "warn",
    );
  }

  if (status === null) {
    setText(view.phone, stale ? "can't reach the session" : "waiting to pair");
    setText(view.rate, NO_VALUE);
    setText(view.fresh, NO_VALUE);
    setText(view.mcp, "none yet");
    setText(view.age, NO_VALUE);
    setText(view.ttl, NO_VALUE);
    return;
  }
  setText(
    view.phone,
    stale
      ? "last known — retrying"
      : status.phone.streaming
        ? "connected, streaming"
        : "paired but quiet",
  );
  setText(view.rate, formatHz(status.phone.rateHz));
  setText(view.fresh, formatAge(status.phone.lastFrameAgeS));
  setText(view.mcp, formatMcp(status.mcp));
  setText(view.age, formatClock(status.session.ageS));
  setText(view.ttl, formatClock(status.session.expiresInS));
}

/**
 * Phase → chip label/tone plus the sentence under the dials. Kept in one place
 * so the phone never shows two different stories at once.
 * @param {StreamState} state
 * @returns {{label: string, tone: ChipTone, message: string}}
 */
export function describeStream(state) {
  if (state.message !== null && state.phase === "denied") {
    return { label: "blocked", tone: "bad", message: state.message };
  }
  switch (state.phase) {
    case "idle":
      return { label: "idle", tone: "neutral", message: "" };
    case "requesting":
      return { label: "asking", tone: "warn", message: "Waiting for the browser's permission prompt…" };
    case "unsupported":
      return { label: "unsupported", tone: "bad", message: state.message ?? "" };
    case "denied":
      return { label: "blocked", tone: "bad", message: state.message ?? "" };
    case "waiting-data":
      return {
        label: "waiting",
        tone: "warn",
        message: state.message ?? "Listening for the first sensor reading…",
      };
    case "streaming":
      return { label: "live", tone: "live", message: state.message ?? "" };
    case "paused-hidden":
      return {
        label: "paused",
        tone: "warn",
        message: state.message ?? "Paused — bring this page back to the foreground.",
      };
    case "paused-rate":
      return {
        label: "paused",
        tone: "warn",
        message: `Paused by the server's rate limit — resuming in ${state.resumeInS ?? 0} s.`,
      };
    case "retrying":
      return {
        label: "retrying",
        tone: "warn",
        message: `Upload failed — retrying in ${state.resumeInS ?? 0} s. Frames are still being buffered.`,
      };
    case "stopped":
      return { label: "stopped", tone: "neutral", message: state.message ?? "" };
    default:
      return { label: "unknown", tone: "neutral", message: "" };
  }
}

/**
 * @typedef {object} PhoneView
 * @property {HTMLElement} chip
 * @property {HTMLElement} heading
 * @property {HTMLElement} headingLabel
 * @property {HTMLElement} tilt
 * @property {HTMLElement} motionChip
 * @property {HTMLElement} aMag
 * @property {HTMLElement} rate
 * @property {HTMLElement} sent
 * @property {HTMLElement} dropped
 * @property {HTMLElement} lastPost
 * @property {HTMLElement} absolute
 * @property {HTMLElement} message
 * @property {{set: (headingDeg: number|null, absolute: boolean) => void}} compass
 * @property {{set: (pitchDeg: number|null, rollDeg: number|null) => void}} level
 */

/**
 * @param {PhoneView} view
 * @param {StreamState} state
 */
export function renderStreamState(view, state) {
  const described = describeStream(state);
  setChip(view.chip, described.label, described.tone);
  // #stream-msg is an aria-live=polite region and this runs ~5×/s; rewriting it
  // with the same sentence re-announces it on every mutation (the chattiness the
  // desktop announcer guards against). Only write when the text actually changes.
  if (view.message.textContent !== described.message) setText(view.message, described.message);

  const reading = state.reading;
  const heading = reading?.headingDeg ?? null;
  view.compass.set(heading, reading?.headingAbsolute ?? false);
  view.level.set(reading?.pitchDeg ?? null, reading?.rollDeg ?? null);

  setText(view.heading, formatDegrees(heading));
  setText(
    view.headingLabel,
    reading === null || heading === null
      ? "heading"
      : reading.headingAbsolute
        ? "heading (compass)"
        : "heading (relative)",
  );
  setText(
    view.tilt,
    reading === null || (reading.pitchDeg === null && reading.rollDeg === null)
      ? NO_VALUE
      : `${formatSignedDegrees(reading.pitchDeg)} / ${formatSignedDegrees(reading.rollDeg)}`,
  );

  setChip(
    view.motionChip,
    state.motion,
    state.motion === "moving" ? "live" : state.motion === "still" ? "good" : "neutral",
  );
  setText(view.aMag, state.aMag === null ? NO_VALUE : `${state.aMag.toFixed(2)} m/s²`);
  setText(view.rate, formatHz(state.sampleHz));
  setText(view.sent, String(state.framesSent));
  setText(view.dropped, String(state.framesDropped));
  setText(view.lastPost, formatAge(state.lastPostAgeS));
  setText(view.absolute, describeHeadingSource(reading));
}

/**
 * @param {import("./sensors.js").OrientationReading|null} reading
 * @returns {string}
 */
export function describeHeadingSource(reading) {
  if (reading === null) return NO_VALUE;
  switch (reading.headingSource) {
    case "ios-compass":
      return "compass (iOS)";
    case "absolute-alpha":
      return "compass (absolute)";
    case "relative-alpha":
      return "relative to start";
    case "none":
      return NO_VALUE;
    default:
      return NO_VALUE;
  }
}

/**
 * @param {StreamState} state
 * @returns {string}
 */
export function describeWakeLock(state) {
  switch (state.wakeLock) {
    case "held":
      return "Holding the screen awake for this session.";
    case "refused":
      return "The browser refused a screen wake lock — turn off auto-lock for now.";
    case "unsupported":
      return "This browser can't hold the screen awake. Turn off auto-lock, or keep tapping the screen.";
    case "released":
      return "Screen wake lock released — the screen may sleep and pause the stream.";
    default:
      return "";
  }
}

/*  clipboard  */

/**
 * Async Clipboard API first; the legacy `execCommand` textarea remains the only
 * option on insecure origins and older Safari, so it stays as a fallback.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused or no transient activation — fall through.
    }
  }
  const shim = document.createElement("textarea");
  shim.value = text;
  shim.setAttribute("readonly", "readonly");
  shim.setAttribute("aria-hidden", "true");
  shim.className = "copy-shim";
  document.body.append(shim);
  shim.select();
  shim.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  shim.remove();
  return copied;
}

/**
 * Digits read one by one, so a screen reader says "four eight one two nine
 * three" rather than "four hundred eighty-one thousand…".
 * @param {string} code
 * @returns {string}
 */
export function spellCode(code) {
  return code.split("").join(" ");
}
