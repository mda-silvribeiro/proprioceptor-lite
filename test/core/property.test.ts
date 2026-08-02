// Property-based tests (fast-check). The sibling suites pin behaviour with
// hand-picked cases; this file drives the same entry points with generated
// input — including NaN, ±Infinity, out-of-range values and unsorted time —
// and asserts the invariants that must hold for EVERY input, per
// docs/CONTRACTS.md: NaN-fail-closed gates, null over guesswork, and the
// ring's capacity/age bounds.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  A_MAG_MAX,
  HEADING_MAX_EXCLUSIVE,
  MAX_FRAMES_PER_BATCH,
  PITCH_ABS_MAX,
  ROLL_ABS_MAX,
  validateBatch,
} from "../../src/core/validate";
import { FrameRing, decodeEntries, encodeEntries, type RingEntry } from "../../src/core/ring";
import { CONFIDENCE_MAX, CONFIDENCE_MIN, classify } from "../../src/core/activity";
import { constantTimeEqual, isCodeShaped, isTokenShaped, mintCode, mintToken } from "../../src/core/tokens";
import type { Frame } from "../../src/core/types";

/** A value in [lo, hi] (or [lo, hi) with maxExcluded), never NaN or ±Infinity. */
function finiteIn(lo: number, hi: number, maxExcluded = false): fc.Arbitrary<number> {
  return fc.double({ min: lo, max: hi, maxExcluded, noNaN: true, noDefaultInfinity: true });
}

function orNull<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null> {
  return fc.option(arb, { nil: null });
}

/** Positive safe integer, across the full range the contract admits for tMs. */
const validTMs: fc.Arbitrary<number> = fc
  .double({ min: 1, max: Number.MAX_SAFE_INTEGER, noNaN: true, noDefaultInfinity: true })
  .map(Math.floor);

/** A frame the contract accepts — every field finite-in-range or null. */
const validFrame: fc.Arbitrary<Frame> = fc.record({
  tMs: validTMs,
  headingDeg: orNull(finiteIn(0, HEADING_MAX_EXCLUSIVE, true)),
  pitchDeg: orNull(finiteIn(-PITCH_ABS_MAX, PITCH_ABS_MAX)),
  rollDeg: orNull(finiteIn(-ROLL_ABS_MAX, ROLL_ABS_MAX)),
  headingAbsolute: fc.boolean(),
  aMag: orNull(finiteIn(0, A_MAG_MAX)),
});

const nonFinite = fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);

describe("validateBatch properties", () => {
  it("accepts every in-contract batch and echoes it unchanged, in order", () => {
    fc.assert(
      fc.property(fc.array(validFrame, { maxLength: MAX_FRAMES_PER_BATCH }), (frames) => {
        const result = validateBatch({ frames });
        if (!result.ok) throw new Error(`rejected a valid batch: ${result.message}`);
        expect(result.frames).toEqual(frames);
      }),
    );
  });

  it("rejects a non-finite value in any numeric field of any frame (NaN-fail-closed)", () => {
    const numericKeys = ["tMs", "headingDeg", "pitchDeg", "rollDeg", "aMag"] as const;
    fc.assert(
      fc.property(
        fc.array(validFrame, { minLength: 1, maxLength: MAX_FRAMES_PER_BATCH }),
        fc.nat(),
        fc.constantFrom(...numericKeys),
        nonFinite,
        (frames, indexSeed, key, poison) => {
          const index = indexSeed % frames.length;
          const poisoned = frames.map((frame, i) =>
            i === index ? { ...frame, [key]: poison } : frame,
          );
          const result = validateBatch({ frames: poisoned });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.status).toBe(422);
        },
      ),
    );
  });

  it("rejects any out-of-range value in a bounded field", () => {
    const outOfRange = fc.oneof(
      fc.record({ key: fc.constant("headingDeg" as const), value: fc.constantFrom(-0.001, 360, 361, 1e9) }),
      fc.record({ key: fc.constant("pitchDeg" as const), value: fc.constantFrom(-90.001, 90.001, 1e9) }),
      fc.record({ key: fc.constant("rollDeg" as const), value: fc.constantFrom(-180.001, 180.001, 1e9) }),
      fc.record({ key: fc.constant("aMag" as const), value: fc.constantFrom(-0.001, 80.001, 1e9) }),
    );
    fc.assert(
      fc.property(validFrame, outOfRange, (frame, bad) => {
        const result = validateBatch({ frames: [{ ...frame, [bad.key]: bad.value }] });
        expect(result.ok).toBe(false);
      }),
    );
  });

  it("rejects any batch over the frame cap and any frame with an unknown key", () => {
    fc.assert(
      fc.property(
        fc.array(validFrame, { minLength: MAX_FRAMES_PER_BATCH + 1, maxLength: MAX_FRAMES_PER_BATCH + 5 }),
        (frames) => {
          expect(validateBatch({ frames }).ok).toBe(false);
        },
      ),
    );
    fc.assert(
      fc.property(validFrame, (frame) => {
        expect(validateBatch({ frames: [{ ...frame, extra: 1 }] }).ok).toBe(false);
      }),
    );
  });
});

describe("FrameRing properties", () => {
  it("holds capacity, age-window and ordering invariants under arbitrary pushes", () => {
    const CAP = 8;
    const WINDOW_MS = 10_000;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            frames: fc.array(validFrame, { maxLength: 5 }),
            advanceMs: fc.integer({ min: 0, max: 60_000 }),
          }),
          { maxLength: 25 },
        ),
        (steps) => {
          const ring = new FrameRing(CAP, WINDOW_MS);
          let now = 1_000_000;
          for (const step of steps) {
            now += step.advanceMs;
            ring.push(step.frames, now);
            expect(ring.count()).toBeLessThanOrEqual(CAP);
            const all = ring.all();
            expect(all.length).toBe(ring.count());
            for (const entry of all) {
              expect(entry.recvMs).toBeGreaterThanOrEqual(now - WINDOW_MS);
              expect(entry.recvMs).toBeLessThanOrEqual(now);
            }
            for (let i = 1; i < all.length; i++) {
              const prev = all[i - 1];
              const cur = all[i];
              if (prev !== undefined && cur !== undefined) {
                expect(cur.recvMs).toBeGreaterThanOrEqual(prev.recvMs);
              }
            }
          }
        },
      ),
    );
  });

  it("encode → decode round-trips every finite entry exactly", () => {
    const entry: fc.Arbitrary<RingEntry> = fc.record({
      recvMs: finiteIn(0, Number.MAX_SAFE_INTEGER),
      frame: validFrame,
    });
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 30 }), (entries) => {
        expect(decodeEntries(encodeEntries(entries))).toEqual(entries);
      }),
    );
  });
});

describe("classify properties", () => {
  // Hostile timestamps: NaN and ±Infinity are legal outputs of fc.double().
  // aMag keeps NaN/±Infinity too, but its finite values stay physically scaled
  // (the wire gate caps aMag at 80): the classifier's mean/variance sums are
  // not defended against 1e308-magnitude overflow, because no gated input can
  // ever carry such a value.
  const hostileSample = fc.record({
    aMag: fc.oneof(fc.double({ min: -1e6, max: 1e6, noNaN: true }), nonFinite),
    recvMs: fc.double(),
    tMs: fc.double(),
  });

  it("never throws and never fabricates, for any input including non-finite", () => {
    fc.assert(
      fc.property(fc.array(hostileSample, { maxLength: 60 }), fc.double(), (samples, nowMs) => {
        const result = classify(samples, nowMs);
        expect(["stationary", "walking", "running", "unknown"]).toContain(result.activity);
        expect(result.confidence).toBeGreaterThanOrEqual(CONFIDENCE_MIN);
        expect(result.confidence).toBeLessThanOrEqual(CONFIDENCE_MAX);
        expect(Number.isFinite(result.sd)).toBe(true);
        expect(result.sd).toBeGreaterThanOrEqual(0);
        expect(result.sampleCount).toBeGreaterThanOrEqual(0);
        expect(result.coverageSeconds).toBeGreaterThanOrEqual(0);
        // Null over guesswork: cadence exists only for walking/running.
        if (result.activity !== "walking" && result.activity !== "running") {
          expect(result.cadenceSpm).toBeNull();
        } else {
          expect(result.cadenceSpm).not.toBeNull();
        }
      }),
    );
  });
});

describe("token properties", () => {
  it("constantTimeEqual agrees with === for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(constantTimeEqual(a, b)).toBe(a === b);
      }),
    );
    fc.assert(
      fc.property(fc.string(), (a) => {
        expect(constantTimeEqual(a, a)).toBe(true);
      }),
    );
  });

  it("every minted token and code is shape-valid", () => {
    for (let i = 0; i < 128; i++) {
      expect(isTokenShaped(mintToken())).toBe(true);
      expect(isCodeShaped(mintCode())).toBe(true);
    }
  });
});
