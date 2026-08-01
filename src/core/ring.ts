// Bounded ring buffer of received frames, per docs/CONTRACTS.md
// § Ring buffer & ephemerality: at most 30 minutes, cap 9 000 frames.
//
// Each entry carries `recvMs`, the SERVER receive time. Freshness and all
// windowing are computed from it, never from the phone's `tMs`, so a skewed or
// hostile phone clock cannot make stale data look fresh. `tMs` is used only for
// ordering frames inside one batch, which is exactly what the contract allows.

import type { Frame } from "./types";

export const RING_CAP = 9000;
export const RING_WINDOW_MS = 30 * 60 * 1000;

export interface RingEntry {
  readonly frame: Frame;
  /** Server receive time in epoch ms. */
  readonly recvMs: number;
}

export class FrameRing {
  private readonly cap: number;
  private readonly maxAgeMs: number;
  private readonly buf: (RingEntry | undefined)[];
  /** Index of the oldest live entry. */
  private head = 0;
  private len = 0;

  constructor(cap: number = RING_CAP, maxAgeMs: number = RING_WINDOW_MS) {
    this.cap = Math.max(1, Math.floor(cap));
    this.maxAgeMs = Math.max(0, maxAgeMs);
    this.buf = new Array<RingEntry | undefined>(this.cap);
  }

  /**
   * Append a validated batch, all stamped with the same server receive time,
   * then evict by age. Frames are inserted in `tMs` order so a batch that
   * arrived out of order is stored in phone-time order; the sort is on a copy
   * and is stable, so equal timestamps keep their transmitted order.
   */
  push(batch: readonly Frame[], nowMs: number): void {
    const ordered = [...batch].sort((a, b) => a.tMs - b.tMs);
    for (const frame of ordered) {
      this.insert({ frame, recvMs: nowMs });
    }
    this.evictOlderThan(nowMs);
  }

  private insert(entry: RingEntry): void {
    if (this.len === this.cap) {
      // Full: overwrite the oldest slot and advance the head (count eviction).
      this.buf[this.head] = entry;
      this.head = (this.head + 1) % this.cap;
      return;
    }
    this.buf[(this.head + this.len) % this.cap] = entry;
    this.len++;
  }

  /** Age eviction. Entries share a receive time per batch, so head-side. */
  private evictOlderThan(nowMs: number): void {
    // Fail closed towards keeping data: with a non-finite clock every `>=`
    // comparison below would be false and the whole ring would be discarded.
    if (!Number.isFinite(nowMs)) return;
    const cutoff = nowMs - this.maxAgeMs;
    while (this.len > 0) {
      const oldest = this.buf[this.head];
      if (oldest === undefined || oldest.recvMs >= cutoff) break;
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.cap;
      this.len--;
    }
  }

  count(): number {
    return this.len;
  }

  newest(): RingEntry | null {
    if (this.len === 0) return null;
    return this.buf[(this.head + this.len - 1) % this.cap] ?? null;
  }

  oldest(): RingEntry | null {
    if (this.len === 0) return null;
    return this.buf[this.head] ?? null;
  }

  /** Oldest-first snapshot of every live entry. */
  all(): RingEntry[] {
    const out: RingEntry[] = [];
    for (let i = 0; i < this.len; i++) {
      const entry = this.buf[(this.head + i) % this.cap];
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  /**
   * Entries with `recvMs` in the closed interval [nowMs - seconds*1000, nowMs].
   * A full scan rather than a backwards short-circuit: nothing in this class
   * assumes the server clock is monotonic across batches.
   */
  window(seconds: number, nowMs: number): RingEntry[] {
    if (!Number.isFinite(seconds) || !Number.isFinite(nowMs)) return [];
    const cutoff = nowMs - Math.max(0, seconds) * 1000;
    const out: RingEntry[] = [];
    for (let i = 0; i < this.len; i++) {
      const entry = this.buf[(this.head + i) % this.cap];
      if (entry === undefined) continue;
      if (entry.recvMs >= cutoff && entry.recvMs <= nowMs) out.push(entry);
    }
    return out;
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) this.buf[i] = undefined;
    this.head = 0;
    this.len = 0;
  }

  /** Rebuild from a decoded snapshot, oldest first. */
  static fromEntries(
    entries: readonly RingEntry[],
    cap: number = RING_CAP,
    maxAgeMs: number = RING_WINDOW_MS,
  ): FrameRing {
    const ring = new FrameRing(cap, maxAgeMs);
    for (const entry of entries) ring.insert(entry);
    return ring;
  }
}

/**
 * Compact snapshot encoding: positional tuples rather than objects, because the
 * snapshot is written to Durable Object storage whose per-value size is bounded.
 * Order is [recvMs, tMs, headingDeg, pitchDeg, rollDeg, headingAbsolute, aMag].
 */
export type EncodedEntry = [
  number,
  number,
  number | null,
  number | null,
  number | null,
  0 | 1,
  number | null,
];

export function encodeEntries(entries: readonly RingEntry[]): EncodedEntry[] {
  return entries.map((e) => [
    e.recvMs,
    e.frame.tMs,
    e.frame.headingDeg,
    e.frame.pitchDeg,
    e.frame.rollDeg,
    e.frame.headingAbsolute ? 1 : 0,
    e.frame.aMag,
  ]);
}

/** Finite-or-null coercion: a snapshot from an older build must not smuggle in
 *  NaN, and storage contents are treated as untrusted on the way back in. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function decodeEntries(value: unknown): RingEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RingEntry[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const recvMs = num(row[0]);
    const tMs = num(row[1]);
    if (recvMs === null || tMs === null) continue;
    out.push({
      recvMs,
      frame: {
        tMs,
        headingDeg: num(row[2]),
        pitchDeg: num(row[3]),
        rollDeg: num(row[4]),
        headingAbsolute: row[5] === 1 || row[5] === true,
        aMag: num(row[6]),
      },
    });
  }
  return out;
}
