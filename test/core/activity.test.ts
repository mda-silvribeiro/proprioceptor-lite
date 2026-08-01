import { describe, expect, it } from "vitest";
import {
  ACTIVITY_WINDOW_S,
  CADENCE_RUN_MIN,
  CONFIDENCE_MIN,
  SD_STATIONARY,
  accelSamples,
  classify,
  findPeaks,
  type AccelSample,
} from "../../src/core/activity";

const START = 1_700_000_000_000;

interface WaveOptions {
  freqHz: number;
  amplitude: number;
  rateHz?: number;
  seconds?: number;
  startMs?: number;
  offset?: number;
}

/** Deterministic synthetic aMag series; tMs == recvMs, as an honest client sends. */
function wave(options: WaveOptions): AccelSample[] {
  const rateHz = options.rateHz ?? 50;
  const seconds = options.seconds ?? ACTIVITY_WINDOW_S;
  const startMs = options.startMs ?? START;
  const offset = options.offset ?? 9.8;
  const n = Math.round(rateHz * seconds);
  const out: AccelSample[] = [];
  for (let k = 0; k < n; k++) {
    const t = k / rateHz;
    const ms = startMs + Math.round(t * 1000);
    out.push({
      aMag: offset + options.amplitude * Math.sin(2 * Math.PI * options.freqHz * t),
      recvMs: ms,
      tMs: ms,
    });
  }
  return out;
}

function newestMs(samples: readonly AccelSample[]): number {
  return samples[samples.length - 1]?.recvMs ?? START;
}

describe("classify — class thresholds", () => {
  it("flat signal with tiny noise is stationary and reports no cadence", () => {
    const samples = wave({ freqHz: 0.5, amplitude: 0.05 });
    const result = classify(samples, newestMs(samples));
    expect(result.activity).toBe("stationary");
    expect(result.cadenceSpm).toBeNull();
    expect(result.sd).toBeLessThan(SD_STATIONARY);
  });

  it("1.8 Hz at ~2 m/s² is walking at roughly 108 spm", () => {
    const samples = wave({ freqHz: 1.8, amplitude: 2 });
    const result = classify(samples, newestMs(samples));
    expect(result.activity).toBe("walking");
    expect(result.cadenceSpm).not.toBeNull();
    expect(result.cadenceSpm ?? 0).toBeGreaterThanOrEqual(98);
    expect(result.cadenceSpm ?? 0).toBeLessThanOrEqual(118);
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it("2.8 Hz at ~4 m/s² is running", () => {
    const samples = wave({ freqHz: 2.8, amplitude: 4 });
    const result = classify(samples, newestMs(samples));
    expect(result.activity).toBe("running");
    expect(result.cadenceSpm ?? 0).toBeGreaterThanOrEqual(CADENCE_RUN_MIN);
    expect(result.sd).toBeGreaterThanOrEqual(1.5);
  });

  it("a running cadence with too little energy is unknown, not running", () => {
    // 2.8 Hz cadence but only ~2 m/s² amplitude, so sd stays under SD_RUNNING.
    // Running needs BOTH gates, and the walking band excludes cadences ≥ 144,
    // so the honest answer is unknown rather than a downgrade to walking.
    const samples = wave({ freqHz: 2.8, amplitude: 2 });
    const result = classify(samples, newestMs(samples));
    expect(result.sd).toBeLessThan(1.5);
    expect(result.activity).toBe("unknown");
    expect(result.cadenceSpm).toBeNull();
  });

  it("a slow shuffle below the walking cadence floor is unknown", () => {
    const samples = wave({ freqHz: 0.6, amplitude: 2 });
    const result = classify(samples, newestMs(samples));
    expect(result.activity).toBe("unknown");
    expect(result.cadenceSpm).toBeNull();
  });
});

describe("classify — evidence gates", () => {
  it("no samples at all is unknown at the confidence floor", () => {
    const result = classify([], START);
    expect(result.activity).toBe("unknown");
    expect(result.confidence).toBe(CONFIDENCE_MIN);
    expect(result.cadenceSpm).toBeNull();
    expect(result.sd).toBe(0);
  });

  it("four samples is unknown regardless of what they look like", () => {
    const samples = wave({ freqHz: 1.8, amplitude: 2 }).slice(-4);
    const result = classify(samples, newestMs(samples));
    expect(result.sampleCount).toBe(4);
    expect(result.activity).toBe("unknown");
    expect(result.confidence).toBe(CONFIDENCE_MIN);
  });

  it("a window whose newest sample is over 3 s old is unknown", () => {
    // 50 dense samples that still sit inside the 4 s window, but whose newest is
    // 3.01 s before `now` — only the staleness gate can reject this.
    const samples = wave({ freqHz: 1.8, amplitude: 2, seconds: 1 });
    const stale = classify(samples, newestMs(samples) + 3010);
    expect(stale.sampleCount).toBeGreaterThanOrEqual(8);
    expect(stale.activity).toBe("unknown");
    expect(stale.confidence).toBe(CONFIDENCE_MIN);

    // The same data 2.9 s old still classifies: the gate is the staleness, not
    // the sample count.
    const fresh = classify(samples, newestMs(samples) + 2900);
    expect(fresh.activity).toBe("walking");
    expect(fresh.confidence).toBeLessThan(0.9);
  });

  it("freshness is measured on recvMs, so a lying tMs cannot revive stale data", () => {
    const samples = wave({ freqHz: 1.8, amplitude: 2 }).map((s) => ({
      ...s,
      tMs: s.tMs + 10_000_000,
    }));
    const result = classify(samples, newestMs(samples) + 10_000);
    expect(result.activity).toBe("unknown");
  });

  it("ignores samples outside the 4 s window", () => {
    const old = wave({ freqHz: 1.8, amplitude: 2, seconds: 10 });
    const now = newestMs(old);
    const result = classify(old, now);
    // 4 s at 50 Hz, plus the boundary sample.
    expect(result.sampleCount).toBeLessThanOrEqual(50 * ACTIVITY_WINDOW_S + 1);
    expect(result.coverageSeconds).toBeCloseTo(ACTIVITY_WINDOW_S, 1);
  });

  it("skips non-finite samples instead of letting them poison the statistics", () => {
    const samples = [
      ...wave({ freqHz: 1.8, amplitude: 2 }),
      { aMag: Number.NaN, recvMs: START + 3990, tMs: START + 3990 },
      { aMag: 10, recvMs: Number.NaN, tMs: START + 3990 },
      { aMag: 10, recvMs: START + 3990, tMs: Number.POSITIVE_INFINITY },
    ];
    const result = classify(samples, START + 3990);
    expect(Number.isFinite(result.sd)).toBe(true);
    expect(result.activity).toBe("walking");
  });

  it("is unknown when nowMs itself is not finite", () => {
    expect(classify(wave({ freqHz: 1.8, amplitude: 2 }), Number.NaN).activity).toBe("unknown");
  });
});

describe("classify — confidence is monotone in evidence", () => {
  it("never rises as the same waveform is truncated", () => {
    const full = wave({ freqHz: 1.8, amplitude: 2 });
    const now = newestMs(full);
    const chain = [full, full.slice(-100), full.slice(-50), full.slice(-20), full.slice(-8)];
    const confidences = chain.map((s) => classify(s, now).confidence);
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i] ?? 1).toBeLessThanOrEqual(confidences[i - 1] ?? 0);
    }
    expect(confidences[0]).toBeCloseTo(0.9, 5);
  });

  it("never rises as the same waveform is decimated", () => {
    const full = wave({ freqHz: 1.8, amplitude: 2 });
    const now = newestMs(full);
    const decimate = (step: number): AccelSample[] => full.filter((_s, i) => i % step === 0);
    const confidences = [1, 5, 10, 20].map((step) => classify(decimate(step), now).confidence);
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i] ?? 1).toBeLessThanOrEqual(confidences[i - 1] ?? 0);
    }
  });

  it("does not drop when an interior sample is added to a clustered window", () => {
    // 8 samples packed into a 1.2 s sub-window — a real >5 Hz burst. Adding a 9th
    // sample *inside* that span leaves the covered span unchanged but raises the
    // count, so confidence must not fall. Regression for the coverage term once
    // being rawSpan·n/(n-1), which decreased as an interior sample arrived.
    const at = (ms: number): AccelSample => ({
      aMag: 9.8 + 2 * Math.sin(2 * Math.PI * 1.8 * (ms / 1000)),
      recvMs: ms,
      tMs: ms,
    });
    const now = START + 1200;
    const eight = Array.from({ length: 8 }, (_v, k) => at(START + Math.round((k * 1200) / 7)));
    const nine = [...eight, at(START + 600)];
    const before = classify(eight, now).confidence;
    const after = classify(nine, now).confidence;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("stays within [CONFIDENCE_MIN, 0.9]", () => {
    for (const freq of [0.5, 1.2, 1.8, 2.5, 2.8]) {
      for (const seconds of [0.5, 1, 2, 4]) {
        const samples = wave({ freqHz: freq, amplitude: 2, seconds });
        const c = classify(samples, newestMs(samples)).confidence;
        expect(c).toBeGreaterThanOrEqual(CONFIDENCE_MIN);
        expect(c).toBeLessThanOrEqual(0.9);
      }
    }
  });
});

describe("findPeaks", () => {
  const times = (n: number, stepMs: number): number[] =>
    Array.from({ length: n }, (_v, i) => i * stepMs);

  it("finds nothing in a flat series", () => {
    const values = Array.from({ length: 20 }, () => 0);
    expect(findPeaks(values, times(20, 100))).toEqual([]);
  });

  it("rejects peaks below the prominence floor", () => {
    const values = [0, 0.5, 0, 0.5, 0];
    expect(findPeaks(values, times(5, 500))).toEqual([]);
    const tall = [0, 0.7, 0, 0.7, 0];
    expect(findPeaks(tall, times(5, 500))).toEqual([1, 3]);
  });

  it("thins peaks closer together than the minimum spacing, keeping the taller", () => {
    // Peaks at indices 1 and 3, 0.2 s apart: only the taller survives.
    const values = [0, 1, 0, 2, 0];
    expect(findPeaks(values, times(5, 100))).toEqual([3]);
  });

  it("reports one peak for a plateau", () => {
    const values = [0, 2, 2, 2, 0];
    expect(findPeaks(values, times(5, 500))).toEqual([1]);
  });

  it("returns indices in chronological order", () => {
    const values = [0, 3, 0, 1, 0, 2, 0];
    expect(findPeaks(values, times(7, 400))).toEqual([1, 3, 5]);
  });
});

describe("accelSamples", () => {
  it("drops frames with no accelerometer magnitude", () => {
    const entries = [
      { frame: { aMag: null, tMs: 1 }, recvMs: 10 },
      { frame: { aMag: 9.8, tMs: 2 }, recvMs: 20 },
      { frame: { aMag: Number.NaN, tMs: 3 }, recvMs: 30 },
    ];
    expect(accelSamples(entries)).toEqual([{ aMag: 9.8, recvMs: 20, tMs: 2 }]);
  });
});
