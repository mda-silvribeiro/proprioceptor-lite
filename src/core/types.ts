// Shared types. docs/CONTRACTS.md is the source of truth; these types
// mirror it and must change only together with it.

/** One validated sensor frame (phone → server). */
export interface Frame {
  /** Phone epoch ms — ordering & cadence deltas only; never freshness. */
  tMs: number;
  headingDeg: number | null;
  pitchDeg: number | null;
  rollDeg: number | null;
  headingAbsolute: boolean;
  /** |accelerationIncludingGravity| in m/s². */
  aMag: number | null;
}

export type Activity = "stationary" | "walking" | "running" | "unknown";

export interface Orientation {
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  headingAbsolute: boolean;
}

/** The MCP-facing state. Missing data is null, never a fabricated zero. */
export interface MotionState {
  freshSeconds: number | null;
  orientation: Orientation | null;
  activity: Activity;
  cadenceSpm: number | null;
  confidence: number;
  samples: { count: number; windowSeconds: number };
  session: { ageSeconds: number; expiresInSeconds: number };
}

/**
 * Output of `motion_get_orientation`: a strict subset of MotionState.
 * Additive to the contract types — the two fields keep MotionState's meaning.
 */
export interface OrientationState {
  freshSeconds: number | null;
  orientation: Orientation | null;
}

export interface ActivityBout {
  activity: Activity;
  startOffsetS: number;
  durationS: number;
}

export interface SessionSummary {
  windowSeconds: number;
  samples: number;
  movingPercent: number;
  stationaryPercent: number;
  unknownPercent: number;
  avgCadenceSpm: number | null;
  headingRangeDeg: { min: number; max: number } | null;
  activityBouts: ActivityBout[];
}

export interface Status {
  phone: { streaming: boolean; rateHz: number | null; lastFrameAgeS: number | null };
  mcp: { totalCalls: number; lastCallAgeS: number | null };
  session: { ageS: number; expiresInS: number };
}
