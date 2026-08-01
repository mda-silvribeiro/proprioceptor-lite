import { describe, expect, it } from "vitest";
import { FrameRing } from "../../src/core/ring";
import type { RingEntry } from "../../src/core/ring";
import {
  MAX_BOUTS,
  buildMotionState,
  buildOrientationState,
  buildSessionSummary,
  type SessionMeta,
} from "../../src/core/state";
import type { Frame } from "../../src/core/types";

const START = 1_700_000_000_000;

function meta(createdMs = START, expiresAtMs = START + 3_600_000): SessionMeta {
  return { createdMs, expiresAtMs };
}

function entry(recvMs: number, over: Partial<Frame> = {}): RingEntry {
  const frame: Frame = {
    tMs: recvMs,
    headingDeg: 123.4,
    pitchDeg: -12,
    rollDeg: 4.2,
    headingAbsolute: true,
    aMag: 9.8,
    ...over,
  };
  return { frame, recvMs };
}

/** A stretch of frames whose aMag traces a sinusoid, at 5 Hz like the page. */
function stretch(
  fromMs: number,
  seconds: number,
  freqHz: number,
  amplitude: number,
  over: Partial<Frame> = {},
): RingEntry[] {
  const out: RingEntry[] = [];
  const n = Math.round(seconds * 5);
  for (let k = 0; k < n; k++) {
    const ms = fromMs + k * 200;
    out.push(
      entry(ms, { aMag: 9.8 + amplitude * Math.sin(2 * Math.PI * freqHz * (ms / 1000)), ...over }),
    );
  }
  return out;
}

describe("buildMotionState — nulls are never fabricated", () => {
  it("reports nothing at all for an empty ring", () => {
    const state = buildMotionState([], meta(), START + 1000);
    expect(state.freshSeconds).toBeNull();
    expect(state.orientation).toBeNull();
    expect(state.activity).toBe("unknown");
    expect(state.cadenceSpm).toBeNull();
    expect(state.samples).toEqual({ count: 0, windowSeconds: 0 });
    expect(state.session.ageSeconds).toBe(1);
  });

  it("measures freshness on the server clock, ignoring the phone's tMs", () => {
    const entries = [entry(START + 1000, { tMs: START + 9_999_999 })];
    const state = buildMotionState(entries, meta(), START + 2800);
    expect(state.freshSeconds).toBe(1.8);
  });

  it("clamps a negative age rather than reporting the future", () => {
    const state = buildMotionState([entry(START + 5000)], meta(), START + 1000);
    expect(state.freshSeconds).toBe(0);
  });

  it("reports session age and the expiry that was in force", () => {
    // The contract's worked example: created 610 s ago, 3 010 s left to run.
    const state = buildMotionState([], meta(START, START + 3_620_000), START + 610_000);
    expect(state.session).toEqual({ ageSeconds: 610, expiresInSeconds: 3010 });
  });

  it("never reports a negative expiry", () => {
    const state = buildMotionState([], meta(START, START + 1000), START + 999_000);
    expect(state.session.expiresInSeconds).toBe(0);
  });

  it("counts samples and the span they cover", () => {
    const entries = [entry(START), entry(START + 120_000), entry(START + 240_000)];
    const state = buildMotionState(entries, meta(), START + 240_000);
    expect(state.samples).toEqual({ count: 3, windowSeconds: 240 });
  });
});

describe("orientation selection", () => {
  it("uses the newest frame that has all three angles", () => {
    const entries = [
      entry(START + 1000, { headingDeg: 10 }),
      entry(START + 2000, { headingDeg: null }),
      entry(START + 3000, { rollDeg: null }),
      entry(START + 4000, { pitchDeg: null }),
    ];
    const state = buildOrientationState(entries, START + 4000);
    expect(state.orientation).toEqual({
      headingDeg: 10,
      pitchDeg: -12,
      rollDeg: 4.2,
      headingAbsolute: true,
    });
    // Freshness still refers to the newest frame, not the newest orientation.
    expect(state.freshSeconds).toBe(0);
  });

  it("returns null when nothing in the last 3 s carries an orientation", () => {
    const entries = [entry(START + 1000, { headingDeg: 10 })];
    expect(buildOrientationState(entries, START + 4001).orientation).toBeNull();
    expect(buildOrientationState(entries, START + 3999).orientation).not.toBeNull();
  });

  it("returns null when every recent frame has a null heading", () => {
    const entries = [entry(START + 1000, { headingDeg: null })];
    const state = buildOrientationState(entries, START + 1000);
    expect(state.orientation).toBeNull();
    expect(state.freshSeconds).toBe(0);
  });

  it("carries headingAbsolute through unchanged", () => {
    const entries = [entry(START, { headingAbsolute: false })];
    expect(buildOrientationState(entries, START).orientation?.headingAbsolute).toBe(false);
  });
});

describe("buildSessionSummary", () => {
  it("is all-empty for an empty ring, with no invented ranges or bouts", () => {
    const summary = buildSessionSummary([], START);
    expect(summary).toEqual({
      windowSeconds: 0,
      samples: 0,
      movingPercent: 0,
      stationaryPercent: 0,
      unknownPercent: 0,
      avgCadenceSpm: null,
      headingRangeDeg: null,
      activityBouts: [],
    });
  });

  it("needs two non-null headings for a heading range", () => {
    const one = [entry(START, { headingDeg: 12 }), entry(START + 200, { headingDeg: null })];
    expect(buildSessionSummary(one, START + 200).headingRangeDeg).toBeNull();

    const two = [entry(START, { headingDeg: 12 }), entry(START + 200, { headingDeg: 305.5 })];
    expect(buildSessionSummary(two, START + 200).headingRangeDeg).toEqual({ min: 12, max: 305.5 });
  });

  it("shares sum to exactly 100 over the classified windows", () => {
    // A moving / stationary / unknown mix whose naive per-share rounding would
    // drift off 100; largest-remainder apportionment must land it exactly.
    const entries = [
      ...stretch(START, 20, 0.2, 0.02),
      ...stretch(START + 20_000, 20, 1.8, 2),
      ...stretch(START + 40_000, 20, 0.2, 0.02),
    ];
    const summary = buildSessionSummary(entries, START + 60_000);
    const total = summary.movingPercent + summary.stationaryPercent + summary.unknownPercent;
    expect(total).toBeCloseTo(100, 6);
    expect(summary.samples).toBe(entries.length);
    expect(summary.windowSeconds).toBeGreaterThan(55);
  });

  it("merges adjacent equal windows into bouts, newest last", () => {
    const entries = [
      ...stretch(START, 20, 0.2, 0.02),
      ...stretch(START + 20_000, 20, 1.8, 2),
    ];
    const summary = buildSessionSummary(entries, START + 40_000);
    expect(summary.activityBouts.length).toBeGreaterThanOrEqual(2);
    expect(summary.activityBouts.length).toBeLessThanOrEqual(4);

    // Offsets increase and no two adjacent bouts share an activity.
    let previousOffset = -1;
    for (let i = 0; i < summary.activityBouts.length; i++) {
      const bout = summary.activityBouts[i];
      if (bout === undefined) throw new Error("missing bout");
      expect(bout.startOffsetS).toBeGreaterThan(previousOffset);
      previousOffset = bout.startOffsetS;
      expect(bout.durationS).toBeGreaterThan(0);
      const next = summary.activityBouts[i + 1];
      if (next !== undefined) expect(next.activity).not.toBe(bout.activity);
    }
    expect(summary.activityBouts.map((b) => b.activity)).toContain("stationary");
    expect(summary.activityBouts.map((b) => b.activity)).toContain("walking");
    expect(summary.avgCadenceSpm).not.toBeNull();
  });

  it("caps bouts at 20 and keeps the newest", () => {
    // Alternate 4 s of quiet and 4 s of walking so every window differs from
    // its neighbour and no merging can occur.
    const entries: RingEntry[] = [];
    for (let i = 0; i < 60; i++) {
      const from = START + i * 4000;
      entries.push(...(i % 2 === 0 ? stretch(from, 4, 0.2, 0.02) : stretch(from, 4, 1.8, 2)));
    }
    const summary = buildSessionSummary(entries, START + 240_000);
    expect(summary.activityBouts).toHaveLength(MAX_BOUTS);
    const last = summary.activityBouts[MAX_BOUTS - 1];
    if (last === undefined) throw new Error("missing bout");
    // Newest last: the final bout must end at the end of the ring.
    expect(last.startOffsetS + last.durationS).toBeGreaterThan(230);
  });

  it("does not drift with wall-clock time — it describes the frames held", () => {
    const entries = stretch(START, 20, 1.8, 2);
    const early = buildSessionSummary(entries, START + 20_000);
    const late = buildSessionSummary(entries, START + 999_000);
    expect(late).toEqual(early);
  });

  it("reports one window for a single frame without inventing a span", () => {
    const summary = buildSessionSummary([entry(START)], START);
    expect(summary.windowSeconds).toBe(0);
    expect(summary.samples).toBe(1);
    expect(summary.activityBouts).toHaveLength(1);
    expect(summary.activityBouts[0]?.activity).toBe("unknown");
    expect(summary.unknownPercent).toBe(100);
  });
});

describe("state built straight off a FrameRing", () => {
  it("agrees with the classifier on a live walking ring", () => {
    const ring = new FrameRing(9000, 30 * 60 * 1000);
    for (const e of stretch(START, 30, 1.8, 2)) ring.push([e.frame], e.recvMs);
    const now = START + 30_000;
    const state = buildMotionState(ring.all(), meta(), now);
    expect(state.activity).toBe("walking");
    expect(state.cadenceSpm).not.toBeNull();
    expect(state.orientation).not.toBeNull();
    expect(state.freshSeconds).toBeLessThanOrEqual(0.2);
  });
});
