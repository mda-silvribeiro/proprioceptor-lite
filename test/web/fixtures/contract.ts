// Frame validation, written straight from docs/CONTRACTS.md § Frame. The page is
// the only writer of this wire format, so these assertions are the front end's
// half of the contract test: strict key set, finite-before-range checks, and no
// fabricated zeros where the platform gave us nothing.

import { expect } from "@playwright/test";

export interface Frame {
  tMs: number;
  headingDeg: number | null;
  pitchDeg: number | null;
  rollDeg: number | null;
  headingAbsolute: boolean;
  aMag: number | null;
}

/** The exact key set the server accepts — extra keys are a 422. */
const FRAME_KEYS = ["tMs", "headingDeg", "pitchDeg", "rollDeg", "headingAbsolute", "aMag"];

/** docs/CONTRACTS.md § HTTP endpoints. */
export const MAX_FRAMES_PER_BATCH = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableRange(label: string, value: unknown, lo: number, hi: number): number | null {
  if (value === null) return null;
  expect(typeof value, `${label} must be a number or null, got ${typeof value}`).toBe("number");
  const numeric = value as number;
  // Finite first, then range — exactly the order the server uses so that NaN
  // fails closed instead of sneaking past `x < lo || x > hi`.
  expect(Number.isFinite(numeric), `${label} must be finite, got ${String(numeric)}`).toBe(true);
  expect(
    numeric >= lo && numeric <= hi,
    `${label} must be within [${lo}, ${hi}], got ${String(numeric)}`,
  ).toBe(true);
  return numeric;
}

/** Validates one ingest body and returns its frames. */
export function parseIngestBody(body: unknown): Frame[] {
  expect(isRecord(body), "ingest body must be an object").toBe(true);
  const record = body as Record<string, unknown>;
  expect(Object.keys(record).sort(), "ingest body has exactly one key: frames").toEqual(["frames"]);
  const frames = record["frames"];
  expect(Array.isArray(frames), "frames must be an array").toBe(true);
  const list = frames as unknown[];
  expect(list.length, `at most ${MAX_FRAMES_PER_BATCH} frames per batch`).toBeLessThanOrEqual(
    MAX_FRAMES_PER_BATCH,
  );
  expect(list.length, "a batch is never empty").toBeGreaterThan(0);
  return list.map((frame, index) => parseFrame(frame, index));
}

export function parseFrame(value: unknown, index: number): Frame {
  expect(isRecord(value), `frame ${index} must be an object`).toBe(true);
  const record = value as Record<string, unknown>;
  expect(Object.keys(record).sort(), `frame ${index} has exactly the contract keys`).toEqual(
    [...FRAME_KEYS].sort(),
  );

  const tMs = record["tMs"];
  expect(typeof tMs, `frame ${index} tMs must be a number`).toBe("number");
  expect(Number.isSafeInteger(tMs), `frame ${index} tMs must be a safe integer`).toBe(true);
  expect(tMs as number, `frame ${index} tMs must be > 0`).toBeGreaterThan(0);

  const headingAbsolute = record["headingAbsolute"];
  expect(typeof headingAbsolute, `frame ${index} headingAbsolute must be a boolean`).toBe("boolean");

  return {
    tMs: tMs as number,
    headingDeg: nullableRange(`frame ${index} headingDeg`, record["headingDeg"], 0, 359.999999),
    pitchDeg: nullableRange(`frame ${index} pitchDeg`, record["pitchDeg"], -90, 90),
    rollDeg: nullableRange(`frame ${index} rollDeg`, record["rollDeg"], -180, 180),
    headingAbsolute: headingAbsolute as boolean,
    aMag: nullableRange(`frame ${index} aMag`, record["aMag"], 0, 80),
  };
}

/** Flattens every recorded ingest body into one frame list. */
export function allFrames(bodies: readonly unknown[]): Frame[] {
  return bodies.flatMap((body) => parseIngestBody(body));
}
