import { describe, expect, it } from "vitest";
import { MAX_FRAMES_PER_BATCH, validateBatch } from "../../src/core/validate";

/** A frame that must always pass, so every case below changes exactly one thing. */
function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tMs: 1753795200000,
    headingDeg: 123.4,
    pitchDeg: -12,
    rollDeg: 4.2,
    headingAbsolute: true,
    aMag: 10.1,
    ...overrides,
  };
}

function reject(body: unknown): string {
  const result = validateBatch(body);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  expect(result.status).toBe(422);
  return result.message;
}

function accept(body: unknown): void {
  const result = validateBatch(body);
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.message}`);
}

/** Values that must never pass any numeric gate. Infinity is reachable from
 *  JSON (`1e999` parses to it); NaN is not, but the gates must still fail closed. */
const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
const NUMERIC_FIELDS = ["tMs", "headingDeg", "pitchDeg", "rollDeg", "aMag"] as const;

describe("validateBatch — happy path", () => {
  it("accepts a well-formed batch and returns the frames", () => {
    const result = validateBatch({ frames: [frame(), frame({ tMs: 1753795200200 })] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toEqual({
      tMs: 1753795200000,
      headingDeg: 123.4,
      pitchDeg: -12,
      rollDeg: 4.2,
      headingAbsolute: true,
      aMag: 10.1,
    });
  });

  it("accepts an empty batch (a POST with nothing to report is not an error)", () => {
    const result = validateBatch({ frames: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toHaveLength(0);
  });

  it("accepts nulls in every nullable field", () => {
    accept({ frames: [frame({ headingDeg: null, pitchDeg: null, rollDeg: null, aMag: null })] });
  });

  it("accepts the inclusive range boundaries", () => {
    accept({ frames: [frame({ headingDeg: 0, pitchDeg: -90, rollDeg: -180, aMag: 0 })] });
    accept({ frames: [frame({ headingDeg: 359.999, pitchDeg: 90, rollDeg: 180, aMag: 80 })] });
  });

  it("accepts exactly the batch limit and rejects one more", () => {
    const ok = Array.from({ length: MAX_FRAMES_PER_BATCH }, (_v, i) =>
      frame({ tMs: 1753795200000 + i }),
    );
    accept({ frames: ok });
    expect(reject({ frames: [...ok, frame()] })).toMatch(/at most 25 frames/);
  });
});

describe("validateBatch — envelope", () => {
  it("rejects non-object bodies", () => {
    for (const body of [null, undefined, 5, "frames", true, [] as unknown[]]) {
      expect(reject(body)).toMatch(/body must be a JSON object/);
    }
  });

  it("rejects unknown top-level keys (strict schema)", () => {
    expect(reject({ frames: [], device: "pixel" })).toMatch(/unknown key "device"/);
  });

  it("sanitises an input-derived key name in the error message", () => {
    const message = reject({ frames: [], "<script>": 1 });
    expect(message).not.toContain("<");
    expect(message).not.toContain(">");
  });

  it("rejects a missing or non-array frames field", () => {
    expect(reject({})).toMatch(/frames must be an array/);
    expect(reject({ frames: null })).toMatch(/frames must be an array/);
    expect(reject({ frames: {} })).toMatch(/frames must be an array/);
  });

  it("rejects a non-object frame", () => {
    expect(reject({ frames: [null] })).toMatch(/frames\[0\] must be a JSON object/);
    expect(reject({ frames: [[]] })).toMatch(/frames\[0\] must be a JSON object/);
    expect(reject({ frames: ["x"] })).toMatch(/frames\[0\] must be a JSON object/);
  });

  it("rejects unknown and missing frame keys, naming the index", () => {
    expect(reject({ frames: [frame(), frame({ extra: 1 })] })).toMatch(
      /frames\[1\] has unknown key "extra"/,
    );
    for (const key of ["tMs", "headingDeg", "pitchDeg", "rollDeg", "headingAbsolute", "aMag"]) {
      const partial = frame();
      delete partial[key];
      expect(reject({ frames: [partial] })).toBe(`frames[0].${key} is missing`);
    }
  });

  it("reports the first bad frame, not the last", () => {
    const body = { frames: [frame(), frame({ aMag: 999 }), frame({ pitchDeg: 999 })] };
    expect(reject(body)).toMatch(/frames\[1\]\.aMag/);
  });
});

describe("validateBatch — NaN and ±Infinity never pass a gate", () => {
  for (const field of NUMERIC_FIELDS) {
    for (const value of NON_FINITE) {
      it(`rejects ${field} = ${String(value)}`, () => {
        expect(reject({ frames: [frame({ [field]: value })] })).toContain(`frames[0].${field}`);
      });
    }
  }

  it("rejects Infinity arriving through JSON.parse (1e999)", () => {
    const parsed: unknown = JSON.parse('{"frames":[{"tMs":1,"headingDeg":1e999,' +
      '"pitchDeg":0,"rollDeg":0,"headingAbsolute":true,"aMag":1}]}');
    expect(reject(parsed)).toMatch(/frames\[0\]\.headingDeg/);
  });
});

describe("validateBatch — per-field ranges and types", () => {
  it("tMs must be a safe integer > 0", () => {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, "1753795200000", null, true]) {
      expect(reject({ frames: [frame({ tMs: bad })] })).toMatch(
        /frames\[0\]\.tMs must be a safe integer > 0/,
      );
    }
    accept({ frames: [frame({ tMs: 1 })] });
  });

  it("headingDeg is [0,360) or null", () => {
    for (const bad of [-0.001, 360, 360.1, 1e6, "123", true, {}]) {
      expect(reject({ frames: [frame({ headingDeg: bad })] })).toMatch(/frames\[0\]\.headingDeg/);
    }
  });

  it("pitchDeg is [-90,90] or null", () => {
    for (const bad of [-90.001, 90.001, "0", false]) {
      expect(reject({ frames: [frame({ pitchDeg: bad })] })).toMatch(/frames\[0\]\.pitchDeg/);
    }
  });

  it("rollDeg is [-180,180] or null", () => {
    for (const bad of [-180.001, 180.001, "0", []]) {
      expect(reject({ frames: [frame({ rollDeg: bad })] })).toMatch(/frames\[0\]\.rollDeg/);
    }
  });

  it("aMag is [0,80] or null", () => {
    for (const bad of [-0.001, 80.001, 1000, "10", {}]) {
      expect(reject({ frames: [frame({ aMag: bad })] })).toMatch(/frames\[0\]\.aMag/);
    }
  });

  it("headingAbsolute must be a real boolean, and null is not allowed", () => {
    for (const bad of [null, "true", 1, 0, undefined]) {
      expect(reject({ frames: [frame({ headingAbsolute: bad })] })).toMatch(
        /frames\[0\]\.headingAbsolute/,
      );
    }
  });
});
