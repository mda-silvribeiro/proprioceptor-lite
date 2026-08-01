// Ingest-batch validation, per docs/CONTRACTS.md § Frame.
//
// Every numeric gate is written in the inverted form `x >= lo && x <= hi`
// guarded by Number.isFinite. The naive form `x < lo || x > hi` evaluates to
// false for NaN, which would let NaN through as "in range"; the gates here
// fail closed for NaN and ±Inf. That is a contract, not a preference.

import type { Frame } from "./types";

export const MAX_FRAMES_PER_BATCH = 25;
export const HEADING_MAX_EXCLUSIVE = 360;
export const PITCH_ABS_MAX = 90;
export const ROLL_ABS_MAX = 180;
export const A_MAG_MAX = 80;

export interface ValidateOk {
  ok: true;
  frames: Frame[];
}

export interface ValidateErr {
  ok: false;
  status: 422;
  message: string;
}

export type ValidateResult = ValidateOk | ValidateErr;

/** Exactly these keys, no more, no fewer — strict schema per the contract. */
const FRAME_KEYS = ["tMs", "headingDeg", "pitchDeg", "rollDeg", "headingAbsolute", "aMag"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite and within a closed interval. NaN/±Inf fail here, not later. */
function inClosed(value: unknown, lo: number, hi: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= lo && value <= hi;
}

/** Finite and within [lo, hi) — used for headingDeg's exclusive 360. */
function inHalfOpen(value: unknown, lo: number, hi: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= lo && value < hi;
}

/**
 * Input-derived text appears in the 422 body, so strip it to a conservative
 * charset and length. Nothing user-derived ever reaches an LLM prompt in this
 * project, and this keeps that true even for error paths.
 */
function safeLabel(key: string): string {
  let out = "";
  for (const ch of key.slice(0, 32)) {
    out += /[A-Za-z0-9_]/.test(ch) ? ch : "?";
  }
  return out;
}

function err(message: string): ValidateErr {
  return { ok: false, status: 422, message };
}

/**
 * Validate a parsed `POST /ingest/<token>` body. Returns the whole batch or the
 * first failure — first bad frame wins, and the message names field and index.
 */
export function validateBatch(body: unknown): ValidateResult {
  if (!isRecord(body)) return err("body must be a JSON object");

  for (const key of Object.keys(body)) {
    if (key !== "frames") return err(`unknown key "${safeLabel(key)}" in body`);
  }

  const raw = body["frames"];
  if (!Array.isArray(raw)) return err("frames must be an array");
  if (raw.length > MAX_FRAMES_PER_BATCH) {
    return err(`frames must contain at most ${MAX_FRAMES_PER_BATCH} frames, got ${raw.length}`);
  }

  const frames: Frame[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = validateFrame(raw[i], i);
    if (!result.ok) return result;
    frames.push(result.frame);
  }
  return { ok: true, frames };
}

type FrameResult = { ok: true; frame: Frame } | ValidateErr;

function validateFrame(value: unknown, i: number): FrameResult {
  if (!isRecord(value)) return err(`frames[${i}] must be a JSON object`);

  const known = new Set<string>(FRAME_KEYS);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) return err(`frames[${i}] has unknown key "${safeLabel(key)}"`);
  }
  for (const key of FRAME_KEYS) {
    if (!(key in value)) return err(`frames[${i}].${key} is missing`);
  }

  const tMs = value["tMs"];
  // Phone epoch ms. Safe integer so downstream deltas cannot lose precision;
  // > 0 rejects the 0/negative sentinels a broken client might send.
  if (typeof tMs !== "number" || !Number.isSafeInteger(tMs) || !(tMs > 0)) {
    return err(`frames[${i}].tMs must be a safe integer > 0`);
  }

  const headingAbsolute = value["headingAbsolute"];
  if (typeof headingAbsolute !== "boolean") {
    return err(`frames[${i}].headingAbsolute must be a boolean`);
  }

  const headingDeg = value["headingDeg"];
  if (headingDeg !== null && !inHalfOpen(headingDeg, 0, HEADING_MAX_EXCLUSIVE)) {
    return err(`frames[${i}].headingDeg must be a finite number in [0,360) or null`);
  }

  const pitchDeg = value["pitchDeg"];
  if (pitchDeg !== null && !inClosed(pitchDeg, -PITCH_ABS_MAX, PITCH_ABS_MAX)) {
    return err(`frames[${i}].pitchDeg must be a finite number in [-90,90] or null`);
  }

  const rollDeg = value["rollDeg"];
  if (rollDeg !== null && !inClosed(rollDeg, -ROLL_ABS_MAX, ROLL_ABS_MAX)) {
    return err(`frames[${i}].rollDeg must be a finite number in [-180,180] or null`);
  }

  const aMag = value["aMag"];
  if (aMag !== null && !inClosed(aMag, 0, A_MAG_MAX)) {
    return err(`frames[${i}].aMag must be a finite number in [0,80] or null`);
  }

  return {
    ok: true,
    frame: { tMs, headingDeg, pitchDeg, rollDeg, headingAbsolute, aMag },
  };
}
