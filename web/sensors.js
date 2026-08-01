/**
 * Sensor capture, resampling and batched upload.
 *
 * ─── Frames and the heading formula ─────────────────────────────────────────
 *
 * `deviceorientation` reports an intrinsic Z–X'–Y'' Tait–Bryan triple in the
 * *device* frame: +X out of the right edge, +Y out of the top edge, +Z out of
 * the screen.
 *
 *   alpha ∈ [0,360)    about +Z, counter-clockwise positive — the opposite
 *                      sense from a compass bearing.
 *   beta  ∈ [-180,180] about +X — nose up / down.
 *   gamma ∈ [-90,90]   about +Y — roll left / right.
 *
 * HEADING. A bearing runs clockwise from north, hence `360 - alpha`. When the
 * screen is rotated away from the device's natural orientation, the direction
 * the *user* calls forward is no longer the +Y edge but +Y turned by
 * `screen.orientation.angle`, so:
 *
 *     headingDeg = (360 - alpha + screen.orientation.angle) mod 360
 *
 *   Sanity check: phone flat, top edge north → alpha 0 → heading 0. Turn it 90°
 *   clockwise so the top edge faces east: that is -90° about +Z, so alpha = 270
 *   and heading = 90. ✓  In landscape-primary (`angle === 90`) what the user
 *   sees as forward is the device's +X edge, exactly 90° clockwise of +Y —
 *   which is the `+ angle` term. ✓
 *
 *   That number is only a *bearing* when alpha is earth-referenced, which is
 *   precisely what `absolute === true` (or the `deviceorientationabsolute`
 *   event) promises. `headingAbsolute` is set from that promise and nothing
 *   else — never from "it looked plausible".
 *
 *   iOS never sets `absolute`; it ships `webkitCompassHeading` instead, already
 *   a clockwise-from-north bearing for the device's top edge. Use it verbatim:
 *   no `360 -` inversion and no screen-angle term (Safari reports it in the
 *   device's natural frame, and the value is what a hand-held compass reads).
 *
 * PITCH. beta already means nose-up, but it runs to ±180 as the device tips
 * past vertical onto its face, while the contract wants an elevation in
 * [-90,90]. The elevation of the +Y edge is asin(sin beta), i.e. a fold at ±90:
 *   |beta| ≤ 90 → beta;   beta > 90 → 180 - beta;   beta < -90 → -180 - beta.
 *
 * ROLL. The Euler convention confines gamma to ±90 and pushes "rolled past 90°"
 * into beta instead. When |beta| > 90 the device is past vertical, so the true
 * roll is the reflected branch:
 *   |beta| ≤ 90 → gamma;   gamma ≥ 0 → 180 - gamma;   gamma < 0 → -180 - gamma.
 * Face-down and level (beta 180, gamma 0) therefore reads roll 180, pitch 0. ✓
 *
 * Pitch and roll deliberately stay in the *device* frame; they are not
 * re-expressed through the screen angle, because the contract defines them as
 * beta/gamma and a landscape phone's pitch really is its own nose-up angle.
 *
 * ─── Honesty ────────────────────────────────────────────────────────────────
 *
 * A platform that hands us `null` alpha/beta/gamma gets `null` on the wire. We
 * never substitute 0: a heading of 0° means "pointing north", and inventing
 * that from missing data is the one thing this project exists not to do. Values
 * arriving non-finite or outside the contract's range also become `null` rather
 * than being clamped into a plausible-looking lie — except where the range is
 * pure convention (heading wrap-around), which is normalised.
 */

import { ApiError, backoffDelayMs } from "./api.js";

/** @typedef {import("./api.js").Frame} Frame */

/**
 * ~5 Hz, per docs/CONTRACTS.md. Events arrive at ~60 Hz; each animation frame we
 * check whether this much time has passed and, if so, take the latest values.
 */
export const SAMPLE_INTERVAL_MS = 200;
/** One upload per second. */
export const POST_INTERVAL_MS = 1000;
/** Hard contract limit on frames per batch. */
export const MAX_BATCH = 25;
/** Buffer ceiling; overflow drops the OLDEST frames — recency is what matters. */
export const BUFFER_CAP = 25;
/** A sensor sample older than this is stale and no longer describes "now". */
export const STALE_SAMPLE_MS = 1000;
/** Window for the coarse still/moving read-out. */
const MOTION_WINDOW_MS = 4000;
/** docs/CONTRACTS.md § Activity classification: sd < 0.25 m/s² is stationary. */
const STATIONARY_SD = 0.25;
const MOTION_MIN_SAMPLES = 8;
/** Grace period before we admit that no sensor events are arriving at all. */
const NO_DATA_GRACE_MS = 3000;
/** Contract range for |accelerationIncludingGravity|. */
const AMAG_MAX = 80;
/** Rate read-out averages over this trailing window. */
const RATE_WINDOW_MS = 5000;

export const IOS_PERMISSION_HINT =
  "Motion access is blocked for this page. On iOS: Settings → Safari → Motion & Orientation Access, switch it on, then reload this page and tap Start again.";

/**
 * @typedef {object} OrientationInput
 * @property {number|null} alpha
 * @property {number|null} beta
 * @property {number|null} gamma
 * @property {boolean} absolute
 * @property {number|null} compassHeading iOS `webkitCompassHeading`, else null
 */

/** @typedef {"ios-compass"|"absolute-alpha"|"relative-alpha"|"none"} HeadingSource */

/**
 * @typedef {object} OrientationReading
 * @property {number|null} headingDeg
 * @property {number|null} pitchDeg
 * @property {number|null} rollDeg
 * @property {boolean} headingAbsolute
 * @property {HeadingSource} headingSource
 */

/**
 * @typedef {"idle"|"requesting"|"denied"|"unsupported"|"waiting-data"|"streaming"
 *   |"paused-hidden"|"paused-rate"|"retrying"|"stopped"} StreamPhase
 */

/** @typedef {"held"|"unsupported"|"refused"|"released"} WakeLockState */

/**
 * @typedef {object} StreamState
 * @property {StreamPhase} phase
 * @property {OrientationReading|null} reading
 * @property {number|null} aMag
 * @property {"still"|"moving"|"unknown"} motion
 * @property {number|null} sampleHz
 * @property {number} framesSent
 * @property {number} framesDropped
 * @property {number} batches
 * @property {number|null} lastPostAgeS
 * @property {number|null} resumeInS
 * @property {string|null} message
 * @property {WakeLockState} wakeLock
 */

/**
 * @typedef {object} StreamerOptions
 * @property {string} token
 * @property {(token: string, frames: readonly Frame[]) => Promise<number>} send
 * @property {(state: StreamState) => void} onState
 * @property {(error: ApiError) => void} onSessionGone
 */

/** @type {OrientationReading} */
const NO_READING = {
  headingDeg: null,
  pitchDeg: null,
  rollDeg: null,
  headingAbsolute: false,
  headingSource: "none",
};

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  return finite(value) ? value : null;
}

/**
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Wrap any real angle into [0,360). Heading is cyclic, so this fixes a
 * convention rather than inventing data.
 * @param {number} deg
 * @returns {number}
 */
export function normalizeHeading(deg) {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Fold beta ∈ [-180,180] into an elevation in [-90,90]. See the header note.
 * @param {number} beta
 * @returns {number}
 */
export function foldPitch(beta) {
  if (beta > 90) return 180 - beta;
  if (beta < -90) return -180 - beta;
  return beta;
}

/**
 * Recover a roll in [-180,180] from the ±90-confined gamma, using beta to pick
 * the branch. See the header note.
 * @param {number} beta
 * @param {number} gamma
 * @returns {number}
 */
export function unfoldRoll(beta, gamma) {
  if (Math.abs(beta) <= 90) return gamma;
  return gamma >= 0 ? 180 - gamma : -180 - gamma;
}

/**
 * @param {OrientationInput} input
 * @param {number} screenAngleDeg
 * @returns {OrientationReading}
 */
export function orientationFromEvent(input, screenAngleDeg) {
  const { alpha, beta, gamma, absolute, compassHeading } = input;

  /** @type {number|null} */
  let headingDeg = null;
  let headingAbsolute = false;
  /** @type {HeadingSource} */
  let headingSource = "none";

  if (finite(compassHeading)) {
    headingDeg = normalizeHeading(compassHeading);
    headingAbsolute = true;
    headingSource = "ios-compass";
  } else if (finite(alpha)) {
    headingDeg = normalizeHeading(360 - alpha + screenAngleDeg);
    headingAbsolute = absolute === true;
    headingSource = headingAbsolute ? "absolute-alpha" : "relative-alpha";
  }

  const pitchDeg = finite(beta) ? clamp(foldPitch(beta), -90, 90) : null;
  /** @type {number|null} */
  let rollDeg = null;
  if (finite(gamma)) {
    rollDeg = clamp(finite(beta) ? unfoldRoll(beta, gamma) : gamma, -180, 180);
  }

  return { headingDeg, pitchDeg, rollDeg, headingAbsolute, headingSource };
}

/**
 * Read the fields we need off an orientation event by shape rather than by
 * class: `webkitCompassHeading` exists in no DOM typing, and only the event
 * *channel* tells us this is orientation data at all.
 * @param {Event} event
 * @returns {OrientationInput}
 */
export function readOrientationEvent(event) {
  const source = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (event));
  const heading = source["webkitCompassHeading"];
  const accuracy = source["webkitCompassAccuracy"];
  // iOS reports a negative accuracy while the compass is uncalibrated; such a
  // heading is not a bearing, so it is discarded rather than sold as absolute.
  const compassUsable = finite(heading) && (!finite(accuracy) || accuracy >= 0);
  return {
    alpha: finiteOrNull(source["alpha"]),
    beta: finiteOrNull(source["beta"]),
    gamma: finiteOrNull(source["gamma"]),
    absolute: source["absolute"] === true,
    compassHeading: compassUsable ? finiteOrNull(heading) : null,
  };
}

/**
 * |accelerationIncludingGravity|, or null when the platform withholds it.
 * Out-of-range → null: a value clamped to 80 m/s² would be a fabrication.
 * @param {Event} event
 * @returns {number|null}
 */
export function accelMagnitudeFromEvent(event) {
  const source = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (event));
  const accel = source["accelerationIncludingGravity"];
  if (typeof accel !== "object" || accel === null) return null;
  const vector = /** @type {Record<string, unknown>} */ (accel);
  const x = vector["x"];
  const y = vector["y"];
  const z = vector["z"];
  if (!finite(x) || !finite(y) || !finite(z)) return null;
  const magnitude = Math.hypot(x, y, z);
  // Finite check first, then range — NaN must fail closed.
  if (!Number.isFinite(magnitude) || !(magnitude >= 0 && magnitude <= AMAG_MAX)) return null;
  return magnitude;
}

/**
 * `screen.orientation.angle`, with the legacy `window.orientation` fallback for
 * iOS before 16.4 (where -90 means what 270 means here).
 * @returns {number}
 */
export function screenAngle() {
  const orientation = screen.orientation;
  if (orientation && finite(orientation.angle)) return orientation.angle;
  const legacy = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window))[
    "orientation"
  ];
  return finite(legacy) ? normalizeHeading(legacy) : 0;
}

/** @typedef {{requestPermission?: () => Promise<string>}} PermissionGated */

/**
 * iOS 13+ gates the motion sensors behind a per-page grant that can only be
 * requested from a user gesture — asked for from a load handler it fails. That
 * is the entire reason the phone view has a Start button.
 * @returns {boolean}
 */
export function hasPermissionGate() {
  if (typeof DeviceOrientationEvent === "undefined") return false;
  const gated = /** @type {PermissionGated} */ (/** @type {unknown} */ (DeviceOrientationEvent));
  return typeof gated.requestPermission === "function";
}

/**
 * Must be reached synchronously from a user-gesture handler.
 * @returns {Promise<"granted"|"denied"|"not-required"|"error">}
 */
export async function requestMotionPermission() {
  if (!hasPermissionGate()) return "not-required";
  /** @type {string[]} */
  const results = [];
  try {
    const orientationGate = /** @type {PermissionGated} */ (
      /** @type {unknown} */ (DeviceOrientationEvent)
    );
    if (orientationGate.requestPermission) {
      results.push(await orientationGate.requestPermission());
    }
    // Orientation and motion are two separate grants on iOS: the dials need the
    // first, the acceleration read-out the second.
    if (typeof DeviceMotionEvent !== "undefined") {
      const motionGate = /** @type {PermissionGated} */ (/** @type {unknown} */ (DeviceMotionEvent));
      if (motionGate.requestPermission) {
        results.push(await motionGate.requestPermission());
      }
    }
  } catch {
    // Thrown when called outside a gesture, or in an insecure context.
    return "error";
  }
  if (results.length === 0) return "not-required";
  return results.every((result) => result === "granted") ? "granted" : "denied";
}

/** @typedef {{input: OrientationInput, at: number}} TimedOrientation */

/**
 * Captures orientation + motion events, resamples them to ~5 Hz and ships one
 * batch a second with drop-oldest backpressure.
 */
export class MotionStreamer {
  /** @type {StreamerOptions} */
  #options;
  /** @type {StreamPhase} */
  #phase = "idle";
  /** @type {TimedOrientation|null} */
  #absolute = null;
  /** @type {TimedOrientation|null} */
  #relative = null;
  /** @type {{value: number|null, at: number}|null} */
  #accel = null;
  /** @type {Frame[]} */
  #buffer = [];
  /** @type {number[]} epoch ms of recent samples, for the rate read-out */
  #sampleTimes = [];
  /** @type {{value: number, at: number}[]} */
  #aMagWindow = [];
  /** @type {OrientationReading|null} */
  #reading = null;
  #running = false;
  /** @type {number|null} requestAnimationFrame handle */
  #frameRequest = null;
  /** Epoch ms of the last resample, for the ~5 Hz gate inside the rAF loop. */
  #lastSampleAt = 0;
  /** @type {number|null} */
  #postTimer = null;
  /** @type {number|null} */
  #startedAt = null;
  /** @type {number|null} */
  #lastPostAt = null;
  /** @type {number|null} epoch ms until which a 429 keeps us quiet */
  #pausedUntil = null;
  /** @type {number|null} epoch ms until which a failed upload keeps us quiet */
  #retryUntil = null;
  #retryAttempt = 0;
  #framesSent = 0;
  #framesDropped = 0;
  #batches = 0;
  #posting = false;
  #sawEvent = false;
  /** @type {string|null} */
  #message = null;
  /** @type {WakeLockState} */
  #wakeLock = "released";
  /** @type {WakeLockSentinel|null} */
  #sentinel = null;

  /** @type {(event: Event) => void} */
  #onOrientation = (event) => {
    this.#sawEvent = true;
    this.#relative = { input: readOrientationEvent(event), at: Date.now() };
  };

  /** @type {(event: Event) => void} */
  #onAbsoluteOrientation = (event) => {
    this.#sawEvent = true;
    // The event name *is* the promise of an earth reference; some builds forget
    // to set `.absolute` on it, so trust the channel it arrived on.
    const input = { ...readOrientationEvent(event), absolute: true };
    this.#absolute = { input, at: Date.now() };
  };

  /** @type {(event: Event) => void} */
  #onMotion = (event) => {
    this.#sawEvent = true;
    const value = accelMagnitudeFromEvent(event);
    const at = Date.now();
    this.#accel = { value, at };
    if (value !== null) {
      this.#aMagWindow.push({ value, at });
      const cutoff = at - MOTION_WINDOW_MS;
      while (this.#aMagWindow.length > 0 && (this.#aMagWindow[0]?.at ?? 0) < cutoff) {
        this.#aMagWindow.shift();
      }
    }
  };

  /** @type {() => void} */
  #onVisibility = () => {
    if (document.visibilityState === "hidden") {
      // A hidden tab has its timers throttled to a crawl and iOS suspends it
      // outright, so we stop pretending to stream and say so.
      if (this.#running) {
        this.#phase = "paused-hidden";
        this.#message = "Paused — this page has to stay in the foreground with the screen on.";
        this.#emit();
      }
      void this.#releaseWakeLock();
      return;
    }
    if (this.#phase === "paused-hidden") {
      this.#phase = this.#resumePhase();
      this.#message = null;
      this.#emit();
    }
    // A wake lock is released automatically whenever the page hides, so it has
    // to be taken again every time we come back.
    if (this.#running) void this.#acquireWakeLock();
  };

  /**
   * The coalescer. `deviceorientation` fires at display rate; sampling inside
   * requestAnimationFrame means at most one resample per painted frame, and the
   * interval gate thins that to ~5 Hz. It also means sampling stops by itself
   * when the page is hidden, because rAF stops.
   * @type {() => void}
   */
  #loop = () => {
    if (!this.#running) return;
    this.#frameRequest = window.requestAnimationFrame(this.#loop);
    const now = Date.now();
    if (now - this.#lastSampleAt < SAMPLE_INTERVAL_MS) return;
    this.#lastSampleAt = now;
    this.#sample(now);
  };

  /** @param {StreamerOptions} options */
  constructor(options) {
    this.#options = options;
  }

  /** @returns {StreamPhase} */
  get phase() {
    return this.#phase;
  }

  /**
   * Call from a click handler. Resolves false when permission was refused or the
   * platform has no orientation events at all.
   * @returns {Promise<boolean>}
   */
  async start() {
    if (this.#running) return true;
    if (typeof DeviceOrientationEvent === "undefined") {
      this.#phase = "unsupported";
      this.#message =
        "Sensors are unavailable in this browser — it reports no device orientation at all. Open this same link on your phone instead.";
      this.#emit();
      return false;
    }

    this.#phase = "requesting";
    this.#emit();
    const permission = await requestMotionPermission();
    if (permission === "denied") {
      this.#phase = "denied";
      this.#message = IOS_PERMISSION_HINT;
      this.#emit();
      return false;
    }
    if (permission === "error") {
      this.#phase = "denied";
      this.#message =
        "The browser refused the sensor request. It has to come from a tap on a secure (https) page — reload and tap Start.";
      this.#emit();
      return false;
    }

    // These handlers only read event fields, so they never call
    // preventDefault(); `passive` says so and keeps them off the critical path.
    window.addEventListener("deviceorientation", this.#onOrientation, { passive: true });
    // Chromium-only event carrying an earth-referenced yaw. We subscribe to both
    // and prefer whichever produced a fresh sample, because on hardware without
    // a usable magnetometer the absolute event can stay silent forever.
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", this.#onAbsoluteOrientation, {
        passive: true,
      });
    }
    if (typeof DeviceMotionEvent !== "undefined") {
      window.addEventListener("devicemotion", this.#onMotion, { passive: true });
    }
    document.addEventListener("visibilitychange", this.#onVisibility, { passive: true });

    this.#startedAt = Date.now();
    this.#phase = "waiting-data";
    this.#message = null;
    this.#running = true;
    this.#lastSampleAt = 0;
    this.#frameRequest = window.requestAnimationFrame(this.#loop);
    this.#postTimer = window.setInterval(() => void this.#flush(), POST_INTERVAL_MS);
    this.#emit();
    void this.#acquireWakeLock();
    return true;
  }

  /** Detach everything and drop the buffer. Safe to call twice. */
  stop() {
    this.#running = false;
    if (this.#frameRequest !== null) window.cancelAnimationFrame(this.#frameRequest);
    if (this.#postTimer !== null) window.clearInterval(this.#postTimer);
    this.#frameRequest = null;
    this.#postTimer = null;
    window.removeEventListener("deviceorientation", this.#onOrientation);
    window.removeEventListener("deviceorientationabsolute", this.#onAbsoluteOrientation);
    window.removeEventListener("devicemotion", this.#onMotion);
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#buffer = [];
    this.#reading = null;
    this.#accel = null;
    this.#absolute = null;
    this.#relative = null;
    this.#aMagWindow = [];
    this.#sampleTimes = [];
    this.#phase = "stopped";
    void this.#releaseWakeLock();
    this.#emit();
  }

  /** @returns {StreamState} */
  get state() {
    const now = Date.now();
    return {
      phase: this.#phase,
      reading: this.#reading,
      aMag: this.#accel !== null && now - this.#accel.at <= STALE_SAMPLE_MS
        ? this.#accel.value
        : null,
      motion: this.#motionEstimate(now),
      sampleHz: this.#rateHz(now),
      framesSent: this.#framesSent,
      framesDropped: this.#framesDropped,
      batches: this.#batches,
      lastPostAgeS: this.#lastPostAt === null ? null : (now - this.#lastPostAt) / 1000,
      resumeInS: this.#resumeInS(now),
      message: this.#message,
      wakeLock: this.#wakeLock,
    };
  }

  /**
   * One ~5 Hz tick: take the freshest of everything and enqueue one frame.
   * @param {number} now
   */
  #sample(now) {
    if (this.#phase === "paused-hidden") return;

    const oriented = this.#freshestOrientation(now);
    const accelFresh = this.#accel !== null && now - this.#accel.at <= STALE_SAMPLE_MS;

    if (oriented === null && !accelFresh) {
      // Nothing fresh to describe. Sending a frame of all-nulls at 5 Hz would
      // only teach the server that we are alive but blind; staying quiet says
      // the same thing more cheaply and keeps `freshSeconds` honest.
      this.#reading = null;
      if (this.#phase === "streaming") this.#phase = "waiting-data";
      if (!this.#sawEvent && this.#startedAt !== null && now - this.#startedAt > NO_DATA_GRACE_MS) {
        this.#message =
          "No sensor events have arrived. This device or browser may not report orientation — nothing is being sent, rather than zeros.";
      }
      this.#emit();
      return;
    }

    const reading =
      oriented === null ? NO_READING : orientationFromEvent(oriented.input, screenAngle());
    this.#reading = reading;

    /** @type {Frame} */
    const frame = {
      tMs: now,
      headingDeg: reading.headingDeg,
      pitchDeg: reading.pitchDeg,
      rollDeg: reading.rollDeg,
      headingAbsolute: reading.headingAbsolute,
      aMag: accelFresh ? (this.#accel?.value ?? null) : null,
    };

    this.#buffer.push(frame);
    this.#trimBuffer();

    this.#sampleTimes.push(now);
    const rateCutoff = now - RATE_WINDOW_MS;
    while (this.#sampleTimes.length > 0 && (this.#sampleTimes[0] ?? 0) < rateCutoff) {
      this.#sampleTimes.shift();
    }

    if (this.#phase === "waiting-data") {
      this.#phase = "streaming";
      this.#message = null;
    }
    this.#emit();
  }

  /**
   * Prefer the absolute channel while it is fresh; otherwise fall back to the
   * relative one rather than reporting nothing.
   * @param {number} now
   * @returns {TimedOrientation|null}
   */
  #freshestOrientation(now) {
    const absolute = this.#absolute;
    const relative = this.#relative;
    const absoluteFresh =
      absolute !== null && now - absolute.at <= STALE_SAMPLE_MS && absolute.input.alpha !== null;
    const relativeFresh = relative !== null && now - relative.at <= STALE_SAMPLE_MS;
    if (absoluteFresh && absolute !== null) {
      // iOS ships its compass bearing on the plain event; keep that if the
      // absolute channel happens to lack one.
      if (relativeFresh && relative !== null && relative.input.compassHeading !== null) {
        return relative;
      }
      return absolute;
    }
    return relativeFresh ? relative : null;
  }

  /** @returns {Promise<void>} */
  async #flush() {
    if (this.#posting || !this.#running) return;
    if (this.#phase === "paused-hidden") return;

    const now = Date.now();
    const until = this.#pausedUntil ?? this.#retryUntil;
    if (until !== null) {
      if (now < until) {
        this.#emit();
        return;
      }
      this.#pausedUntil = null;
      this.#retryUntil = null;
      if (this.#phase === "paused-rate" || this.#phase === "retrying") {
        this.#phase = this.#resumePhase();
        this.#message = null;
      }
    }
    if (this.#buffer.length === 0) {
      this.#emit();
      return;
    }

    const batch = this.#buffer.splice(0, MAX_BATCH);
    this.#posting = true;
    try {
      const accepted = await this.#options.send(this.#options.token, batch);
      this.#framesSent += accepted;
      this.#batches += 1;
      this.#lastPostAt = Date.now();
      this.#retryAttempt = 0;
      if (this.#phase === "paused-rate" || this.#phase === "retrying") {
        this.#phase = this.#resumePhase();
      }
      this.#message = null;
    } catch (error) {
      this.#handleSendFailure(error, batch);
    } finally {
      this.#posting = false;
      this.#emit();
    }
  }

  /**
   * @param {unknown} error
   * @param {Frame[]} batch
   */
  #handleSendFailure(error, batch) {
    // stop() may have run while the request was in flight — e.g. the user hit
    // "End & erase". Nothing about a dead stream needs a diagnosis.
    if (!this.#running) return;
    const kind = error instanceof ApiError ? error.kind : "network";

    if (kind === "gone") {
      const apiError = error instanceof ApiError
        ? error
        : new ApiError("gone", "That session is gone.");
      this.stop();
      this.#options.onSessionGone(apiError);
      return;
    }

    if (kind === "invalid") {
      // Re-sending would fail identically, so drop the batch and say so instead
      // of looping silently.
      this.#framesDropped += batch.length;
      this.#message = "The server rejected a batch as invalid; it was dropped.";
      return;
    }

    this.#requeue(batch);

    if (kind === "rate-limited") {
      const retryAfterS =
        error instanceof ApiError && finite(error.retryAfterS) ? error.retryAfterS : 5;
      this.#pausedUntil = Date.now() + retryAfterS * 1000;
      this.#phase = "paused-rate";
      this.#message = null;
      return;
    }

    this.#retryAttempt += 1;
    this.#retryUntil = Date.now() + backoffDelayMs(this.#retryAttempt);
    this.#phase = "retrying";
    this.#message = null;
  }

  /**
   * Put an unsent batch back at the front, then re-apply the cap by dropping the
   * oldest frames: under sustained backpressure, recent motion wins.
   * @param {Frame[]} batch
   */
  #requeue(batch) {
    this.#buffer = batch.concat(this.#buffer);
    this.#trimBuffer();
  }

  #trimBuffer() {
    while (this.#buffer.length > BUFFER_CAP) {
      this.#buffer.shift();
      this.#framesDropped += 1;
    }
  }

  /** @returns {StreamPhase} */
  #resumePhase() {
    return this.#reading === null ? "waiting-data" : "streaming";
  }

  /**
   * @param {number} now
   * @returns {number|null} seconds until posting resumes, if paused
   */
  #resumeInS(now) {
    const until = this.#pausedUntil ?? this.#retryUntil;
    if (until === null) return null;
    return Math.max(0, Math.ceil((until - now) / 1000));
  }

  /**
   * @param {number} now
   * @returns {number|null}
   */
  #rateHz(now) {
    if (this.#sampleTimes.length < 2) return null;
    const first = this.#sampleTimes[0];
    if (first === undefined) return null;
    const span = (now - first) / 1000;
    if (span <= 0) return null;
    // n samples span n-1 intervals. Dividing by n would inflate the rate (and a
    // rate we report high is a rate we cannot back up).
    return (this.#sampleTimes.length - 1) / span;
  }

  /**
   * Coarse still/moving only: the standard deviation of |a| against the 0.25
   * m/s² threshold the contract already fixes for `stationary`. The page does
   * NOT classify walking vs running or estimate cadence — that is the server's
   * job (src/core/activity.ts) and its answer is what Claude is told. This
   * exists so whoever holds the phone can see that the numbers are alive.
   * @param {number} now
   * @returns {"still"|"moving"|"unknown"}
   */
  #motionEstimate(now) {
    const cutoff = now - MOTION_WINDOW_MS;
    const values = this.#aMagWindow.filter((s) => s.at >= cutoff).map((s) => s.value);
    if (values.length < MOTION_MIN_SAMPLES) return "unknown";
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance);
    if (!Number.isFinite(sd)) return "unknown";
    return sd < STATIONARY_SD ? "still" : "moving";
  }

  /** @returns {Promise<void>} */
  async #acquireWakeLock() {
    if (!("wakeLock" in navigator)) {
      this.#wakeLock = "unsupported";
      return;
    }
    if (this.#sentinel !== null && !this.#sentinel.released) return;
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      this.#sentinel = sentinel;
      this.#wakeLock = "held";
      sentinel.addEventListener("release", () => {
        if (this.#sentinel === sentinel) {
          this.#wakeLock = "released";
          this.#emit();
        }
      });
    } catch {
      // Denied by the platform, or the document hid mid-request.
      this.#wakeLock = "refused";
    }
    this.#emit();
  }

  /** @returns {Promise<void>} */
  async #releaseWakeLock() {
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    if (sentinel === null || sentinel.released) return;
    try {
      await sentinel.release();
    } catch {
      // Already gone; nothing to do.
    }
    if (this.#wakeLock === "held") this.#wakeLock = "released";
  }

  #emit() {
    this.#options.onState(this.state);
  }
}
