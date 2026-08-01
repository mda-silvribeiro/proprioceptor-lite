import { describe, expect, it } from "vitest";
import { FrameRing, decodeEntries, encodeEntries } from "../../src/core/ring";
import type { Frame } from "../../src/core/types";

function frame(tMs: number, aMag: number | null = 10): Frame {
  return { tMs, headingDeg: 90, pitchDeg: 0, rollDeg: 0, headingAbsolute: true, aMag };
}

describe("FrameRing", () => {
  it("keeps insertion order and reports newest/oldest/count", () => {
    const ring = new FrameRing(10, 60_000);
    ring.push([frame(1), frame(2)], 1000);
    ring.push([frame(3)], 2000);
    expect(ring.count()).toBe(3);
    expect(ring.oldest()?.frame.tMs).toBe(1);
    expect(ring.newest()?.frame.tMs).toBe(3);
    expect(ring.all().map((e) => e.frame.tMs)).toEqual([1, 2, 3]);
  });

  it("stamps every frame in a batch with the server receive time, not tMs", () => {
    const ring = new FrameRing(10, 60_000);
    // A phone claiming to be far in the future must not affect recvMs.
    ring.push([frame(9_999_999_999_999)], 5000);
    expect(ring.newest()?.recvMs).toBe(5000);
  });

  it("evicts by count once the capacity is reached", () => {
    const ring = new FrameRing(3, 600_000);
    ring.push([frame(1), frame(2), frame(3), frame(4), frame(5)], 1000);
    expect(ring.count()).toBe(3);
    expect(ring.all().map((e) => e.frame.tMs)).toEqual([3, 4, 5]);
  });

  it("evicts by age on the next push", () => {
    const ring = new FrameRing(100, 1000);
    ring.push([frame(1)], 1000);
    ring.push([frame(2)], 1500);
    expect(ring.count()).toBe(2);
    // now = 2600 puts the cutoff at 1600, dropping both earlier batches.
    ring.push([frame(3)], 2600);
    expect(ring.all().map((e) => e.frame.tMs)).toEqual([3]);
  });

  it("keeps an entry exactly on the age cutoff", () => {
    const ring = new FrameRing(100, 1000);
    ring.push([frame(1)], 1000);
    ring.push([frame(2)], 2000);
    expect(ring.count()).toBe(2);
  });

  it("window() is inclusive at both ends and excludes the future", () => {
    const ring = new FrameRing(100, 600_000);
    ring.push([frame(1)], 1000);
    ring.push([frame(2)], 3000);
    ring.push([frame(3)], 5000);

    // [3000, 5000]
    expect(ring.window(2, 5000).map((e) => e.frame.tMs)).toEqual([2, 3]);
    // [3001, 5000] — the 3000 entry falls out one millisecond later.
    expect(ring.window(1.999, 5000).map((e) => e.frame.tMs)).toEqual([3]);
    // Nothing after `now` is visible, which is what lets the bout sweep replay
    // historical windows.
    expect(ring.window(10, 3000).map((e) => e.frame.tMs)).toEqual([1, 2]);
    expect(ring.window(0, 5000).map((e) => e.frame.tMs)).toEqual([3]);
  });

  it("window() returns nothing for non-finite arguments", () => {
    const ring = new FrameRing(10, 600_000);
    ring.push([frame(1)], 1000);
    expect(ring.window(Number.NaN, 1000)).toEqual([]);
    expect(ring.window(1, Number.NaN)).toEqual([]);
  });

  it("tolerates out-of-order tMs inside a batch by storing in tMs order", () => {
    const ring = new FrameRing(10, 600_000);
    ring.push([frame(300), frame(100), frame(200)], 1000);
    expect(ring.all().map((e) => e.frame.tMs)).toEqual([100, 200, 300]);
    expect(ring.all().every((e) => e.recvMs === 1000)).toBe(true);
  });

  it("keeps its contents when the clock hands it a non-finite time", () => {
    const ring = new FrameRing(10, 1000);
    ring.push([frame(1)], 1000);
    ring.push([frame(2)], Number.NaN);
    // Nothing is destroyed by a bad clock: the age gate fails towards keeping.
    expect(ring.count()).toBe(2);
  });

  it("clear() empties the ring", () => {
    const ring = new FrameRing(10, 600_000);
    ring.push([frame(1), frame(2)], 1000);
    ring.clear();
    expect(ring.count()).toBe(0);
    expect(ring.newest()).toBeNull();
    expect(ring.oldest()).toBeNull();
    expect(ring.all()).toEqual([]);
  });

  it("survives many wrap-arounds of the backing buffer", () => {
    const ring = new FrameRing(5, 600_000);
    for (let i = 1; i <= 100; i++) ring.push([frame(i)], 1000 + i);
    expect(ring.count()).toBe(5);
    expect(ring.all().map((e) => e.frame.tMs)).toEqual([96, 97, 98, 99, 100]);
  });
});

describe("snapshot codec", () => {
  it("round-trips through encode/decode", () => {
    const ring = new FrameRing(10, 600_000);
    ring.push([frame(1, null), { ...frame(2), headingDeg: null, headingAbsolute: false }], 4242);
    const restored = FrameRing.fromEntries(decodeEntries(encodeEntries(ring.all())), 10, 600_000);
    expect(restored.all()).toEqual(ring.all());
  });

  it("survives a JSON round-trip, which is how storage holds it", () => {
    const ring = new FrameRing(10, 600_000);
    ring.push([frame(7)], 99);
    const wire: unknown = JSON.parse(JSON.stringify(encodeEntries(ring.all())));
    expect(decodeEntries(wire)).toEqual(ring.all());
  });

  it("drops malformed or non-finite rows instead of trusting storage", () => {
    expect(decodeEntries(null)).toEqual([]);
    expect(decodeEntries("nope")).toEqual([]);
    expect(decodeEntries([1, 2, 3])).toEqual([]);
    expect(decodeEntries([[1, 2]])).toEqual([]);
    const decoded = decodeEntries([
      [Number.NaN, 1, 0, 0, 0, 1, 1],
      [1000, 1, "bad", 0, 0, 1, Number.POSITIVE_INFINITY],
    ]);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.frame.headingDeg).toBeNull();
    expect(decoded[0]?.frame.aMag).toBeNull();
  });
});
