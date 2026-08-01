import { describe, expect, it } from "vitest";
import {
  renderMotionState,
  renderOrientationState,
  renderSessionSummary,
} from "../../src/core/text";
import type { MotionState, OrientationState, SessionSummary } from "../../src/core/types";

function state(over: Partial<MotionState> = {}): MotionState {
  return {
    freshSeconds: 1.8,
    orientation: { headingDeg: 123.4, pitchDeg: -12, rollDeg: 4.2, headingAbsolute: true },
    activity: "walking",
    cadenceSpm: 112,
    confidence: 0.9,
    samples: { count: 412, windowSeconds: 240 },
    session: { ageSeconds: 610, expiresInSeconds: 3010 },
    ...over,
  };
}

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    windowSeconds: 240,
    samples: 412,
    movingPercent: 62,
    stationaryPercent: 30,
    unknownPercent: 8,
    avgCadenceSpm: 110,
    headingRangeDeg: { min: 12, max: 305 },
    activityBouts: [{ activity: "walking", startOffsetS: 0, durationS: 120 }],
    ...over,
  };
}

describe("renderMotionState", () => {
  it("renders activity, cadence, heading and freshness", () => {
    const text = renderMotionState(state());
    expect(text).toContain("Walking at ~112 steps/min");
    expect(text).toContain("heading 123° (compass-referenced)");
    expect(text).toContain("data 1.8 s fresh");
    expect(text.endsWith(".")).toBe(true);
  });

  it("is deterministic", () => {
    expect(renderMotionState(state())).toBe(renderMotionState(state()));
  });

  it("marks a relative heading as such", () => {
    const text = renderMotionState(
      state({ orientation: { headingDeg: 5, pitchDeg: 0, rollDeg: 0, headingAbsolute: false } }),
    );
    expect(text).toContain("(relative)");
    expect(text).not.toContain("compass-referenced");
  });

  it("omits the heading entirely when there is no orientation", () => {
    const text = renderMotionState(state({ orientation: null }));
    expect(text).not.toContain("heading");
    expect(text).toContain("Walking");
  });

  it("omits cadence when there is none", () => {
    const text = renderMotionState(state({ activity: "stationary", cadenceSpm: null }));
    expect(text).toContain("Stationary");
    expect(text).not.toContain("steps/min");
  });

  it("says so plainly when no frames have arrived", () => {
    const text = renderMotionState(
      state({ freshSeconds: null, orientation: null, activity: "unknown", cadenceSpm: null }),
    );
    expect(text).toContain("No motion data");
    expect(text).not.toContain("0");
  });

  it("names the unknown activity without pretending to a class", () => {
    const text = renderMotionState(state({ activity: "unknown", cadenceSpm: null }));
    expect(text).toContain("Motion state unknown");
  });
});

describe("renderOrientationState", () => {
  it("renders all three angles", () => {
    const text = renderOrientationState({
      freshSeconds: 0.4,
      orientation: { headingDeg: 123.4, pitchDeg: -12, rollDeg: 4.2, headingAbsolute: true },
    });
    expect(text).toContain("Heading 123°");
    expect(text).toContain("pitch -12°");
    expect(text).toContain("roll 4°");
    expect(text).toContain("data 0.4 s fresh");
  });

  it("reports the absence rather than zeroes", () => {
    const empty: OrientationState = { freshSeconds: null, orientation: null };
    const text = renderOrientationState(empty);
    expect(text).toContain("No orientation available");
    expect(text).not.toContain("0°");
  });
});

describe("renderSessionSummary", () => {
  it("renders shares, cadence, heading span and bout count", () => {
    const text = renderSessionSummary(summary());
    expect(text).toContain("412 samples over 240 s");
    expect(text).toContain("62% moving");
    expect(text).toContain("30% stationary");
    expect(text).toContain("8% unclassified");
    expect(text).toContain("average cadence 110 steps/min");
    expect(text).toContain("heading spanned 12°–305°");
    expect(text).toContain("1 activity bout");
  });

  it("omits cadence and heading range when they are null", () => {
    const text = renderSessionSummary(summary({ avgCadenceSpm: null, headingRangeDeg: null }));
    expect(text).not.toContain("cadence");
    expect(text).not.toContain("heading");
  });

  it("says so plainly for an empty session", () => {
    const text = renderSessionSummary(summary({ samples: 0 }));
    expect(text).toContain("No motion data");
  });

  it("pluralises bouts", () => {
    const text = renderSessionSummary(
      summary({
        activityBouts: [
          { activity: "walking", startOffsetS: 0, durationS: 8 },
          { activity: "stationary", startOffsetS: 8, durationS: 8 },
        ],
      }),
    );
    expect(text).toContain("2 activity bouts");
  });
});
