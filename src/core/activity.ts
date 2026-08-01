// Activity classification, per docs/CONTRACTS.md § Activity classification.
//
// Textbook signal processing on the accelerometer magnitude series: remove the
// window mean, take the standard deviation, count prominent peaks, turn the peak
// count into a cadence, threshold. No sensor fusion happens here — the phone's
// OS already fused the IMU; we only interpret what the browser handed us.
//
// Two clocks, deliberately: the window is selected by `recvMs` (server receive
// time) so a skewed phone clock cannot fake freshness, while peak spacing and
// the cadence denominator use `tMs` (phone time) because a batch of frames
// arrives in one POST and therefore shares a single receive time — intra-batch
// timing only exists in `tMs`. That split is exactly what the contract permits:
// "tMs — used ONLY for intra-batch ordering & cadence deltas".
//
// Every constant below comes from the contract document.

import type { Activity } from "./types";

/** Most recent window the classifier looks at. */
export const ACTIVITY_WINDOW_S = 4;
/** Fewer samples in the window than this ⇒ `unknown`. */
export const MIN_SAMPLES = 8;
/** Newest sample older than this (server clock) ⇒ `unknown`. */
export const MAX_STALENESS_S = 3;
/** A peak must rise this far above the higher of its two flanking valleys. */
export const PEAK_PROMINENCE = 0.6;
/** Two accepted peaks may not be closer together than this. */
export const MIN_PEAK_SPACING_S = 0.35;
export const SD_STATIONARY = 0.25;
export const SD_RUNNING = 1.5;
export const CADENCE_WALK_MIN = 72;
export const CADENCE_RUN_MIN = 144;
/** Sample count that counts as full evidence: 4 s at the page's 5 Hz target. */
export const EXPECTED_SAMPLES = 20;
/**
 * One nominal inter-sample gap, `windowMs / EXPECTED_SAMPLES` (200 ms at the
 * 5 Hz target). Coverage extrapolates the measured span by exactly this much so
 * a fully-populated window reads ~ACTIVITY_WINDOW_S. It is deliberately a fixed
 * constant, not `rawSpan/(n-1)`: an interior sample leaves the span unchanged
 * but shrinks `rawSpan/(n-1)`, which made coverage — and thus confidence — fall
 * as evidence grew, violating the monotone-in-evidence contract.
 */
export const NOMINAL_SAMPLE_INTERVAL_MS = (ACTIVITY_WINDOW_S * 1000) / EXPECTED_SAMPLES;
export const CONFIDENCE_MIN = 0.3;
export const CONFIDENCE_MAX = 0.9;

export interface AccelSample {
  /** |accelerationIncludingGravity| in m/s². */
  readonly aMag: number;
  /** Server receive time in epoch ms — windowing and freshness. */
  readonly recvMs: number;
  /** Phone time in epoch ms — ordering and cadence deltas only. */
  readonly tMs: number;
}

export interface ActivityResult {
  activity: Activity;
  /** null unless walking or running, per the contract. */
  cadenceSpm: number | null;
  confidence: number;
  /** Standard deviation of the mean-removed window, m/s². 0 when no window. */
  sd: number;
  /** Samples that fell inside the classified window. */
  sampleCount: number;
  /** Seconds of the 4 s window actually covered by samples (phone time). */
  coverageSeconds: number;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function unknownResult(sampleCount: number, sd: number, coverageSeconds: number): ActivityResult {
  return {
    activity: "unknown",
    cadenceSpm: null,
    confidence: CONFIDENCE_MIN,
    sd,
    sampleCount,
    coverageSeconds,
  };
}

/**
 * Peak prominence, standard definition: walk out from the candidate in both
 * directions until the signal exceeds the candidate (or the series ends),
 * tracking the minimum along each walk. Prominence is the candidate's height
 * above the higher of the two minima.
 */
function prominenceAt(y: readonly number[], i: number): number {
  const peak = y[i];
  if (peak === undefined) return 0;

  let leftMin = peak;
  for (let j = i - 1; j >= 0; j--) {
    const v = y[j];
    if (v === undefined || v > peak) break;
    if (v < leftMin) leftMin = v;
  }

  let rightMin = peak;
  for (let j = i + 1; j < y.length; j++) {
    const v = y[j];
    if (v === undefined || v > peak) break;
    if (v < rightMin) rightMin = v;
  }

  return peak - Math.max(leftMin, rightMin);
}

/**
 * Indices of accepted peaks, chronological. Candidates are strict-rising /
 * non-strict-falling local maxima (so a plateau yields one peak and a flat
 * series yields none), filtered by prominence, then thinned by the minimum
 * spacing greedily in descending prominence order — ties broken by index, which
 * keeps the result deterministic for periodic signals.
 *
 * `times` must be in the same order as `values` and expressed in ms.
 */
export function findPeaks(
  values: readonly number[],
  times: readonly number[],
  minProminence: number = PEAK_PROMINENCE,
  minSpacingS: number = MIN_PEAK_SPACING_S,
): number[] {
  const candidates: { index: number; prominence: number }[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    const next = values[i + 1];
    if (prev === undefined || cur === undefined || next === undefined) continue;
    if (!(cur > prev && cur >= next)) continue;
    const prominence = prominenceAt(values, i);
    if (prominence >= minProminence) candidates.push({ index: i, prominence });
  }

  candidates.sort((a, b) => b.prominence - a.prominence || a.index - b.index);

  const accepted: number[] = [];
  const spacingMs = minSpacingS * 1000;
  for (const candidate of candidates) {
    const t = times[candidate.index];
    if (t === undefined) continue;
    let tooClose = false;
    for (const other of accepted) {
      const ot = times[other];
      if (ot === undefined) continue;
      if (Math.abs(t - ot) < spacingMs) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) accepted.push(candidate.index);
  }
  accepted.sort((a, b) => a - b);
  return accepted;
}

/**
 * Classify the most recent ACTIVITY_WINDOW_S of `samples` as of `nowMs`.
 *
 * `samples` may be the whole ring; the window is selected here so that callers
 * (current state, and the bout sweep in state.ts) share one code path. Samples
 * received after `nowMs` are excluded, which is what lets the bout sweep replay
 * historical windows through this same function.
 */
export function classify(samples: readonly AccelSample[], nowMs: number): ActivityResult {
  if (!Number.isFinite(nowMs)) return unknownResult(0, 0, 0);

  const cutoff = nowMs - ACTIVITY_WINDOW_S * 1000;
  const inWindow: AccelSample[] = [];
  let newestRecvMs = -Infinity;
  for (const s of samples) {
    // Inverted, NaN-safe gates: a NaN aMag/recvMs/tMs must not enter the window.
    if (!Number.isFinite(s.aMag) || !Number.isFinite(s.recvMs) || !Number.isFinite(s.tMs)) continue;
    if (!(s.recvMs >= cutoff && s.recvMs <= nowMs)) continue;
    inWindow.push(s);
    if (s.recvMs > newestRecvMs) newestRecvMs = s.recvMs;
  }

  const n = inWindow.length;
  if (n === 0) return unknownResult(0, 0, 0);

  // Peak detection needs a time-ordered series; batches arrive ordered but the
  // sort makes the classifier independent of that assumption.
  inWindow.sort((a, b) => a.tMs - b.tMs);
  const values = inWindow.map((s) => s.aMag);
  const times = inWindow.map((s) => s.tMs);

  const firstMs = times[0] ?? 0;
  const lastMs = times[n - 1] ?? 0;
  // Clamped to the nominal window: a phone reporting an implausible tMs span
  // must not be able to inflate or deflate the cadence denominator without limit.
  const rawSpanMs = Math.min(ACTIVITY_WINDOW_S * 1000, Math.max(0, lastMs - firstMs));
  // n samples cover n intervals, not n-1: extrapolating the measured span by one
  // nominal (count-independent) interval makes a fully-populated window measure
  // ~ACTIVITY_WINDOW_S regardless of sample rate, while keeping coverage — and
  // thus confidence and the cadence denominator — monotone in evidence. See
  // NOMINAL_SAMPLE_INTERVAL_MS for why this is a constant, not rawSpan/(n-1).
  const coverageMs = Math.min(ACTIVITY_WINDOW_S * 1000, rawSpanMs + NOMINAL_SAMPLE_INTERVAL_MS);
  const coverageSeconds = round1(coverageMs / 1000);

  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of values) variance += (v - mean) * (v - mean);
  // Population standard deviation: the window is the whole population of samples
  // we hold, not a sample drawn from a larger one.
  const sd = Math.sqrt(variance / n);

  if (n < MIN_SAMPLES) return unknownResult(n, sd, coverageSeconds);
  const stalenessS = (nowMs - newestRecvMs) / 1000;
  if (!(stalenessS <= MAX_STALENESS_S)) return unknownResult(n, sd, coverageSeconds);

  const coverage = clamp01(coverageMs / (ACTIVITY_WINDOW_S * 1000));
  const density = clamp01(n / EXPECTED_SAMPLES);
  // Confidence is monotone in evidence and never claims more than the weaker of
  // the two dimensions: a dense but short window is as weak as a long sparse one.
  const evidence = Math.min(coverage, density);
  const confidence =
    Math.round((CONFIDENCE_MIN + (CONFIDENCE_MAX - CONFIDENCE_MIN) * evidence) * 100) / 100;

  const centred = values.map((v) => v - mean);
  const peaks = findPeaks(centred, times);
  const cadenceSpm = coverageMs > 0 ? Math.round((peaks.length / (coverageMs / 1000)) * 60) : 0;

  if (sd < SD_STATIONARY) {
    return {
      activity: "stationary",
      cadenceSpm: null,
      confidence,
      sd,
      sampleCount: n,
      coverageSeconds,
    };
  }
  if (cadenceSpm >= CADENCE_RUN_MIN && sd >= SD_RUNNING) {
    return { activity: "running", cadenceSpm, confidence, sd, sampleCount: n, coverageSeconds };
  }
  if (cadenceSpm >= CADENCE_WALK_MIN && cadenceSpm < CADENCE_RUN_MIN) {
    // sd >= SD_STATIONARY holds here: the stationary branch above already
    // returned for anything quieter.
    return { activity: "walking", cadenceSpm, confidence, sd, sampleCount: n, coverageSeconds };
  }
  return {
    activity: "unknown",
    cadenceSpm: null,
    confidence,
    sd,
    sampleCount: n,
    coverageSeconds,
  };
}

/** Convenience: pull the classifier's input series out of ring entries. */
export function accelSamples(
  entries: readonly { frame: { aMag: number | null; tMs: number }; recvMs: number }[],
): AccelSample[] {
  const out: AccelSample[] = [];
  for (const e of entries) {
    const aMag = e.frame.aMag;
    if (aMag === null || !Number.isFinite(aMag)) continue;
    out.push({ aMag, recvMs: e.recvMs, tMs: e.frame.tMs });
  }
  return out;
}
