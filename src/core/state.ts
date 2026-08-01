// MotionState / SessionSummary assembly, per docs/CONTRACTS.md.
//
// The honesty contract: missing data is null, never a fabricated zero. Nothing
// in this module invents an orientation, a cadence or a heading range that the
// ring did not actually contain. All ages are measured against the SERVER clock
// (`recvMs`), so a phone cannot make stale data look fresh.

import type {
  ActivityBout,
  Activity,
  MotionState,
  Orientation,
  OrientationState,
  SessionSummary,
} from "./types";
import type { RingEntry } from "./ring";
import { ACTIVITY_WINDOW_S, accelSamples, classify } from "./activity";

/** Orientation older than this is not reported at all. */
export const ORIENTATION_MAX_AGE_S = 3;
export const MAX_BOUTS = 20;
/** The bout sweep steps by one classification window. */
export const BOUT_STEP_S = ACTIVITY_WINDOW_S;
/** 30 min of ring / 4 s per window — a hard bound on sweep work. */
export const MAX_BOUT_WINDOWS = 450;
/** A heading range needs two headings; one heading is a point, not a range. */
export const MIN_HEADINGS_FOR_RANGE = 2;

export interface SessionMeta {
  createdMs: number;
  /** Idle-TTL deadline in epoch ms, as of the moment state was requested. */
  expiresAtMs: number;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function nonNegative(x: number): number {
  return x > 0 ? x : 0;
}

/**
 * Apportion `counts` into one-decimal percentages that sum to exactly 100.0
 * (largest-remainder / Hamilton method). Rounding each share independently
 * drifts the total off 100 by a tenth or two; since the counts partition every
 * classified window, the reported shares must add up to the whole.
 */
function sharesTo100(counts: readonly number[], total: number): number[] {
  if (!(total > 0)) return counts.map(() => 0);
  const UNITS = 1000; // work in tenths of a percent, then divide back by 10
  const exact = counts.map((c) => (c / total) * UNITS);
  const parts = exact.map((x) => Math.floor(x));
  const used = parts.reduce((a, b) => a + b, 0);
  // Hand each leftover unit to the largest fractional remainder first; ties by
  // index so the result is deterministic. leftover < counts.length by
  // construction, so this never runs off the end.
  const byRemainder = parts
    .map((floorVal, i) => ({ i, frac: (exact[i] ?? 0) - floorVal }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < UNITS - used; k++) {
    const idx = byRemainder[k]?.i ?? 0;
    parts[idx] = (parts[idx] ?? 0) + 1;
  }
  return parts.map((p) => p / 10);
}

/** Age of the newest frame in seconds, or null when the ring is empty. */
export function freshSeconds(entries: readonly RingEntry[], nowMs: number): number | null {
  const newest = entries[entries.length - 1];
  if (newest === undefined) return null;
  return round1(nonNegative((nowMs - newest.recvMs) / 1000));
}

/**
 * Newest frame no older than ORIENTATION_MAX_AGE_S that carries all three
 * orientation angles. Frames with a null heading (relative-only platforms that
 * failed to produce one) are skipped rather than half-reported.
 */
export function newestOrientation(
  entries: readonly RingEntry[],
  nowMs: number,
): Orientation | null {
  const cutoff = nowMs - ORIENTATION_MAX_AGE_S * 1000;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (!(entry.recvMs >= cutoff && entry.recvMs <= nowMs)) continue;
    const { headingDeg, pitchDeg, rollDeg, headingAbsolute } = entry.frame;
    if (headingDeg === null || pitchDeg === null || rollDeg === null) continue;
    return { headingDeg, pitchDeg, rollDeg, headingAbsolute };
  }
  return null;
}

/** Span of the ring in whole seconds; 0 for an empty or single-frame ring. */
function ringSpanSeconds(entries: readonly RingEntry[]): number {
  const oldest = entries[0];
  const newest = entries[entries.length - 1];
  if (oldest === undefined || newest === undefined) return 0;
  return Math.round(nonNegative((newest.recvMs - oldest.recvMs) / 1000));
}

export function buildOrientationState(
  entries: readonly RingEntry[],
  nowMs: number,
): OrientationState {
  return {
    freshSeconds: freshSeconds(entries, nowMs),
    orientation: newestOrientation(entries, nowMs),
  };
}

export function buildMotionState(
  entries: readonly RingEntry[],
  meta: SessionMeta,
  nowMs: number,
): MotionState {
  // Classify from only the frames the 4 s window can hold, so the most-polled
  // MCP tool does not allocate an AccelSample for every frame in a ring that may
  // hold 9 000. This is a full scan, not a backward short-circuit: recvMs is not
  // assumed monotonic across batches (see FrameRing.window and classify), and
  // the [cutoff, now] gate here is identical to the one classify applies, so the
  // verdict is unchanged. A non-finite nowMs yields an empty slice and the same
  // `unknown` classify returns for it.
  const cutoff = nowMs - ACTIVITY_WINDOW_S * 1000;
  const recent: RingEntry[] = [];
  for (const e of entries) {
    if (e.recvMs >= cutoff && e.recvMs <= nowMs) recent.push(e);
  }
  const verdict = classify(accelSamples(recent), nowMs);
  return {
    freshSeconds: freshSeconds(entries, nowMs),
    orientation: newestOrientation(entries, nowMs),
    activity: verdict.activity,
    cadenceSpm: verdict.cadenceSpm,
    confidence: verdict.confidence,
    samples: { count: entries.length, windowSeconds: ringSpanSeconds(entries) },
    session: {
      ageSeconds: Math.round(nonNegative((nowMs - meta.createdMs) / 1000)),
      expiresInSeconds: Math.round(nonNegative((meta.expiresAtMs - nowMs) / 1000)),
    },
  };
}

interface SweptWindow {
  activity: Activity;
  cadenceSpm: number | null;
  /** Window end, epoch ms (server clock). */
  endMs: number;
}

/**
 * Replay the classifier over the ring in BOUT_STEP_S steps. Windows are laid out
 * backwards from the newest frame so the newest window — the one a caller cares
 * about most — is always fully covered, and only the oldest window can be partial.
 */
function sweepWindows(entries: readonly RingEntry[]): SweptWindow[] {
  const oldest = entries[0];
  const newest = entries[entries.length - 1];
  if (oldest === undefined || newest === undefined) return [];

  const stepMs = BOUT_STEP_S * 1000;
  const spanMs = nonNegative(newest.recvMs - oldest.recvMs);
  const count = Math.min(MAX_BOUT_WINDOWS, Math.max(1, Math.ceil(spanMs / stepMs)));

  const buckets: RingEntry[][] = [];
  for (let k = 0; k < count; k++) buckets.push([]);
  for (const entry of entries) {
    const k = Math.floor(nonNegative(newest.recvMs - entry.recvMs) / stepMs);
    const bucket = buckets[Math.min(count - 1, k)];
    if (bucket !== undefined) bucket.push(entry);
  }

  const swept: SweptWindow[] = [];
  // Chronological order: bucket count-1 is the oldest window.
  for (let k = count - 1; k >= 0; k--) {
    const bucket = buckets[k];
    if (bucket === undefined) continue;
    const endMs = newest.recvMs - k * stepMs;
    const verdict = classify(accelSamples(bucket), endMs);
    swept.push({ activity: verdict.activity, cadenceSpm: verdict.cadenceSpm, endMs });
  }
  return swept;
}

/** Merge chronologically adjacent windows with the same verdict into bouts. */
function toBouts(swept: readonly SweptWindow[], oldestMs: number): ActivityBout[] {
  const stepMs = BOUT_STEP_S * 1000;
  const bouts: ActivityBout[] = [];
  let runStartMs: number | null = null;
  let runActivity: Activity | null = null;
  let runEndMs = 0;

  const flush = (): void => {
    if (runStartMs === null || runActivity === null) return;
    const startMs = Math.max(oldestMs, runStartMs);
    bouts.push({
      activity: runActivity,
      startOffsetS: round1(nonNegative((startMs - oldestMs) / 1000)),
      durationS: round1(nonNegative((runEndMs - startMs) / 1000)),
    });
  };

  for (const w of swept) {
    if (runActivity === w.activity) {
      runEndMs = w.endMs;
      continue;
    }
    flush();
    runActivity = w.activity;
    runStartMs = w.endMs - stepMs;
    runEndMs = w.endMs;
  }
  flush();

  // Newest last, at most MAX_BOUTS: drop the oldest when the cap is exceeded.
  return bouts.length > MAX_BOUTS ? bouts.slice(bouts.length - MAX_BOUTS) : bouts;
}

/**
 * Summary of the whole ring. `_nowMs` is accepted for symmetry with
 * buildMotionState and deliberately unused: every figure here describes the
 * frames actually held, so it must not drift with wall-clock time.
 */
export function buildSessionSummary(
  entries: readonly RingEntry[],
  _nowMs: number,
): SessionSummary {
  const oldest = entries[0];
  const swept = sweepWindows(entries);

  let moving = 0;
  let stationary = 0;
  let unknown = 0;
  let cadenceSum = 0;
  let cadenceCount = 0;
  for (const w of swept) {
    if (w.activity === "walking" || w.activity === "running") moving++;
    else if (w.activity === "stationary") stationary++;
    else unknown++;
    if (w.cadenceSpm !== null) {
      cadenceSum += w.cadenceSpm;
      cadenceCount++;
    }
  }

  // Denominator is every classified window. Apportioned with largest-remainder
  // so the three shares sum to exactly 100.0 rather than drifting on rounding.
  const total = swept.length;
  const shares = sharesTo100([moving, stationary, unknown], total);
  const movingPercent = shares[0] ?? 0;
  const stationaryPercent = shares[1] ?? 0;
  const unknownPercent = shares[2] ?? 0;

  let min = Infinity;
  let max = -Infinity;
  let headings = 0;
  for (const entry of entries) {
    const h = entry.frame.headingDeg;
    if (h === null || !Number.isFinite(h)) continue;
    headings++;
    if (h < min) min = h;
    if (h > max) max = h;
  }

  return {
    windowSeconds: ringSpanSeconds(entries),
    samples: entries.length,
    movingPercent,
    stationaryPercent,
    unknownPercent,
    avgCadenceSpm: cadenceCount === 0 ? null : Math.round(cadenceSum / cadenceCount),
    headingRangeDeg:
      headings >= MIN_HEADINGS_FOR_RANGE ? { min: round1(min), max: round1(max) } : null,
    activityBouts: oldest === undefined ? [] : toBouts(swept, oldest.recvMs),
  };
}
