// Human-readable rendering of MotionState / SessionSummary for MCP
// `content[0].text`.
//
// Renders only from typed fields produced by our own pipeline: numbers, enums
// and nulls. There is no free-text field anywhere in the wire format, and no
// input string is ever interpolated here — so nothing user- or device-authored
// can reach an LLM prompt through this path. Output is deterministic: same
// input, same string, no locale-dependent formatting.

import type { MotionState, OrientationState, SessionSummary } from "./types";

const ACTIVITY_PHRASE = {
  stationary: "Stationary",
  walking: "Walking",
  running: "Running",
  unknown: "Motion state unknown",
} as const;

/** Fixed-decimal formatting without Intl/locale involvement. */
function fixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return "n/a";
  const scale = 10 ** digits;
  const rounded = Math.round(x * scale) / scale;
  return digits === 0 ? String(Math.round(rounded)) : rounded.toFixed(digits);
}

function headingPhrase(state: OrientationState): string | null {
  const o = state.orientation;
  if (o === null) return null;
  const reference = o.headingAbsolute ? "compass-referenced" : "relative";
  return `heading ${fixed(o.headingDeg, 0)}° (${reference})`;
}

function freshPhrase(freshSeconds: number | null): string {
  return freshSeconds === null ? "no data yet" : `data ${fixed(freshSeconds, 1)} s fresh`;
}

export function renderMotionState(state: MotionState): string {
  if (state.freshSeconds === null) {
    return "No motion data in this session yet — the phone has not sent any frames.";
  }

  const parts: string[] = [];
  let lead = ACTIVITY_PHRASE[state.activity];
  if (state.cadenceSpm !== null) lead += ` at ~${fixed(state.cadenceSpm, 0)} steps/min`;
  parts.push(lead);

  const heading = headingPhrase(state);
  if (heading !== null) parts.push(heading);
  parts.push(freshPhrase(state.freshSeconds));

  const tail =
    `confidence ${fixed(state.confidence, 2)}, ` +
    `${state.samples.count} samples over ${fixed(state.samples.windowSeconds, 0)} s`;
  return `${parts.join(", ")} (${tail}).`;
}

export function renderOrientationState(state: OrientationState): string {
  const o = state.orientation;
  if (o === null) {
    return "No orientation available — nothing with a full heading/pitch/roll in the last 3 s.";
  }
  const reference = o.headingAbsolute ? "compass-referenced" : "relative to the page start";
  return (
    `Heading ${fixed(o.headingDeg, 0)}° (${reference}), ` +
    `pitch ${fixed(o.pitchDeg, 0)}°, roll ${fixed(o.rollDeg, 0)}°, ` +
    `${freshPhrase(state.freshSeconds)}.`
  );
}

export function renderSessionSummary(summary: SessionSummary): string {
  if (summary.samples === 0) {
    return "No motion data in this session yet — nothing to summarise.";
  }

  const parts: string[] = [
    `${summary.samples} samples over ${fixed(summary.windowSeconds, 0)} s`,
    `${fixed(summary.movingPercent, 0)}% moving`,
    `${fixed(summary.stationaryPercent, 0)}% stationary`,
    `${fixed(summary.unknownPercent, 0)}% unclassified`,
  ];
  if (summary.avgCadenceSpm !== null) {
    parts.push(`average cadence ${fixed(summary.avgCadenceSpm, 0)} steps/min`);
  }
  const range = summary.headingRangeDeg;
  if (range !== null) {
    parts.push(`heading spanned ${fixed(range.min, 0)}°–${fixed(range.max, 0)}°`);
  }
  const bouts = summary.activityBouts.length;
  parts.push(bouts === 1 ? "1 activity bout" : `${bouts} activity bouts`);
  return `${parts.join(", ")}.`;
}
