import { describe, expect, it } from "vitest";
import {
  INGEST_LIMIT,
  MCP_LIMIT,
  MotionSession,
  SESSION_TTL_MS,
  SNAPSHOT_MIN_INTERVAL_MS,
  STREAMING_MAX_AGE_S,
} from "../../src/do";
import { mintToken } from "../../src/core/tokens";
import { MemoryStorage, TestClock, internal, jsonOf } from "./shim";

const TOKEN = mintToken();
const OTHER_TOKEN = mintToken();

interface Fixture {
  session: MotionSession;
  clock: TestClock;
  storage: MemoryStorage;
  restart: () => MotionSession;
}

function fixture(): Fixture {
  const clock = new TestClock();
  const storage = new MemoryStorage();
  const state = { storage };
  const box = { session: new MotionSession(state, {}, { now: clock.now }) };
  return {
    get session() {
      return box.session;
    },
    clock,
    storage,
    restart: () => {
      box.session = new MotionSession(state, {}, { now: clock.now });
      return box.session;
    },
  };
}

async function init(f: Fixture): Promise<void> {
  const response = await f.session.fetch(internal("/internal/init", TOKEN, {}));
  expect(response.status).toBe(200);
}

function frames(count: number, fromMs: number, freqHz = 1.8, amplitude = 2): unknown[] {
  return Array.from({ length: count }, (_v, k) => {
    const tMs = fromMs + k * 200;
    return {
      tMs,
      headingDeg: 100 + (k % 10),
      pitchDeg: -12,
      rollDeg: 4.2,
      headingAbsolute: true,
      aMag: 9.8 + amplitude * Math.sin(2 * Math.PI * freqHz * (tMs / 1000)),
    };
  });
}

async function ingest(f: Fixture, count: number, fromMs: number): Promise<Response> {
  return await f.session.fetch(
    internal("/internal/ingest", TOKEN, { frames: frames(count, fromMs) }),
  );
}

async function mcp(f: Fixture, body: unknown): Promise<Response> {
  return await f.session.fetch(internal("/internal/mcp", TOKEN, body));
}

describe("MotionSession — token gate", () => {
  it("answers every route with a uniform 404 before initialisation", async () => {
    const f = fixture();
    const routes: [string, unknown][] = [
      ["/internal/ingest", { frames: [] }],
      ["/internal/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }],
      ["/internal/end", {}],
    ];
    for (const [path, body] of routes) {
      const response = await f.session.fetch(internal(path, TOKEN, body));
      expect(response.status).toBe(404);
      expect(await jsonOf(response)).toEqual({ error: "unknown session" });
    }
    const status = await f.session.fetch(internal("/internal/status", TOKEN));
    expect(status.status).toBe(404);
  });

  it("answers a mismatched token with the same uniform 404", async () => {
    const f = fixture();
    await init(f);
    const response = await f.session.fetch(internal("/internal/status", OTHER_TOKEN));
    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "unknown session" });
  });

  it("rejects a malformed token and a missing header alike", async () => {
    const f = fixture();
    await init(f);
    const noHeader = await f.session.fetch(
      new Request("https://motion-session.internal/internal/status", { method: "GET" }),
    );
    expect(noHeader.status).toBe(404);
    const badShape = await f.session.fetch(internal("/internal/status", "not-a-token"));
    expect(badShape.status).toBe(404);
  });

  it("refuses to be re-initialised under a different token", async () => {
    const f = fixture();
    await init(f);
    const hijack = await f.session.fetch(internal("/internal/init", OTHER_TOKEN, {}));
    expect(hijack.status).toBe(404);
  });

  it("is idempotent for a repeated init and does not reset the clock", async () => {
    const f = fixture();
    await init(f);
    f.clock.advance(120_000);
    await init(f);
    const status = await jsonOf(await f.session.fetch(internal("/internal/status", TOKEN)));
    const session = status["session"];
    expect((session as { ageS: number }).ageS).toBe(120);
  });

  it("rejects the wrong method on each internal route", async () => {
    const f = fixture();
    await init(f);
    const wrong = await f.session.fetch(
      new Request("https://motion-session.internal/internal/ingest", { method: "GET" }),
    );
    expect(wrong.status).toBe(405);
    const unknownPath = await f.session.fetch(internal("/internal/nope", TOKEN, {}));
    expect(unknownPath.status).toBe(404);
  });
});

describe("MotionSession — ingest", () => {
  it("accepts a batch and reports how many frames landed", async () => {
    const f = fixture();
    await init(f);
    const response = await ingest(f, 5, f.clock.now());
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ accepted: 5 });
  });

  it("rejects an invalid batch with 422 and the field-level message", async () => {
    const f = fixture();
    await init(f);
    const response = await f.session.fetch(
      internal("/internal/ingest", TOKEN, {
        frames: [
          {
            tMs: 1,
            headingDeg: 400,
            pitchDeg: 0,
            rollDeg: 0,
            headingAbsolute: true,
            aMag: 1,
          },
        ],
      }),
    );
    expect(response.status).toBe(422);
    expect(String((await jsonOf(response))["error"])).toContain("frames[0].headingDeg");
  });

  it("rejects a body that is not JSON at all", async () => {
    const f = fixture();
    await init(f);
    const response = await f.session.fetch(
      new Request("https://motion-session.internal/internal/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-token": TOKEN },
        body: "{oops",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rate-limits ingest with a Retry-After and recovers after the window", async () => {
    const f = fixture();
    await init(f);
    for (let i = 0; i < INGEST_LIMIT; i++) {
      expect((await ingest(f, 1, f.clock.now())).status).toBe(200);
    }
    const limited = await ingest(f, 1, f.clock.now());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await jsonOf(limited)).toEqual({ error: "rate limited" });

    f.clock.advance(10_000);
    expect((await ingest(f, 1, f.clock.now())).status).toBe(200);
  });

  it("does not extend the TTL for a rejected batch", async () => {
    const f = fixture();
    await init(f);
    const armedAtInit = f.storage.alarmAtMs;
    f.clock.advance(600_000);
    await f.session.fetch(internal("/internal/ingest", TOKEN, { frames: "nope" }));
    expect(f.storage.alarmAtMs).toBe(armedAtInit);
  });
});

describe("MotionSession — status", () => {
  it("reports streaming, rate and ages, with nulls before anything happens", async () => {
    const f = fixture();
    await init(f);
    const idle = await jsonOf(await f.session.fetch(internal("/internal/status", TOKEN)));
    expect(idle["phone"]).toEqual({ streaming: false, rateHz: null, lastFrameAgeS: null });
    expect(idle["mcp"]).toEqual({ totalCalls: 0, lastCallAgeS: null });
    expect(idle["session"]).toEqual({ ageS: 0, expiresInS: SESSION_TTL_MS / 1000 });
  });

  it("reports the ingest rate over the last 10 s", async () => {
    const f = fixture();
    await init(f);
    for (let i = 0; i < 10; i++) {
      await ingest(f, 5, f.clock.now());
      f.clock.advance(1000);
    }
    const status = await jsonOf(await f.session.fetch(internal("/internal/status", TOKEN)));
    const phone = status["phone"] as { streaming: boolean; rateHz: number; lastFrameAgeS: number };
    expect(phone.streaming).toBe(true);
    expect(phone.rateHz).toBeGreaterThan(3.5);
    expect(phone.rateHz).toBeLessThanOrEqual(5);
    expect(phone.lastFrameAgeS).toBe(1);
  });

  it("stops calling it streaming once frames go quiet", async () => {
    const f = fixture();
    await init(f);
    await ingest(f, 5, f.clock.now());
    f.clock.advance((STREAMING_MAX_AGE_S + 1) * 1000);
    const status = await jsonOf(await f.session.fetch(internal("/internal/status", TOKEN)));
    expect((status["phone"] as { streaming: boolean }).streaming).toBe(false);
  });

  it("counts MCP calls", async () => {
    const f = fixture();
    await init(f);
    await mcp(f, { jsonrpc: "2.0", id: 1, method: "ping" });
    await mcp(f, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    f.clock.advance(12_100);
    const status = await jsonOf(await f.session.fetch(internal("/internal/status", TOKEN)));
    expect(status["mcp"]).toEqual({ totalCalls: 2, lastCallAgeS: 12.1 });
  });

  it("polling status does not re-arm the idle TTL", async () => {
    const f = fixture();
    await init(f);
    f.clock.advance(1_800_000);
    await f.session.fetch(internal("/internal/status", TOKEN));
    const status = await jsonOf(await f.session.fetch(internal("/internal/status", TOKEN)));
    expect((status["session"] as { expiresInS: number }).expiresInS).toBe(1800);
  });
});

describe("MotionSession — MCP", () => {
  it("serves a tools/call over the ring", async () => {
    const f = fixture();
    await init(f);
    for (let i = 0; i < 20; i++) {
      await ingest(f, 5, f.clock.now());
      f.clock.advance(1000);
    }
    const response = await mcp(f, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "motion_get_current_state" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await jsonOf(response);
    const result = body["result"] as Record<string, unknown>;
    const structured = result["structuredContent"] as Record<string, unknown>;
    expect(structured["activity"]).toBe("walking");
    expect(structured["cadenceSpm"]).not.toBeNull();
    expect(structured["orientation"]).not.toBeNull();
    expect(Array.isArray(result["content"])).toBe(true);
  });

  it("serves a cold tools/call with no ingest and no initialize", async () => {
    const f = fixture();
    await init(f);
    const body = await jsonOf(
      await mcp(f, {
        jsonrpc: "2.0",
        id: "cold",
        method: "tools/call",
        params: { name: "motion_get_current_state" },
      }),
    );
    const structured = (body["result"] as Record<string, unknown>)["structuredContent"];
    expect(structured).toMatchObject({
      freshSeconds: null,
      orientation: null,
      activity: "unknown",
      cadenceSpm: null,
    });
  });

  it("answers a notification with an empty 202", async () => {
    const f = fixture();
    await init(f);
    const response = await mcp(f, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("answers unparseable JSON with a JSON-RPC parse error, not a 400", async () => {
    const f = fixture();
    await init(f);
    const response = await f.session.fetch(
      new Request("https://motion-session.internal/internal/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-token": TOKEN },
        body: "{",
      }),
    );
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect((body["error"] as { code: number }).code).toBe(-32700);
  });

  it("reports the expiry that was in force before the call re-armed it", async () => {
    const f = fixture();
    await init(f);
    f.clock.advance(600_000);
    const body = await jsonOf(
      await mcp(f, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "motion_get_current_state" },
      }),
    );
    const structured = (body["result"] as Record<string, unknown>)[
      "structuredContent"
    ] as Record<string, unknown>;
    expect(structured["session"]).toEqual({
      ageSeconds: 600,
      expiresInSeconds: SESSION_TTL_MS / 1000 - 600,
    });
  });

  it("rate-limits MCP calls", async () => {
    const f = fixture();
    await init(f);
    for (let i = 0; i < MCP_LIMIT; i++) {
      expect((await mcp(f, { jsonrpc: "2.0", id: i, method: "ping" })).status).toBe(200);
    }
    const limited = await mcp(f, { jsonrpc: "2.0", id: 999, method: "ping" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    f.clock.advance(60_000);
    expect((await mcp(f, { jsonrpc: "2.0", id: 1000, method: "ping" })).status).toBe(200);
  });

  it("re-arms the idle TTL", async () => {
    const f = fixture();
    await init(f);
    f.clock.advance(120_000);
    await mcp(f, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(f.storage.alarmAtMs).toBe(f.clock.now() + SESSION_TTL_MS);
  });
});

describe("MotionSession — persistence", () => {
  it("snapshots so a restart resumes rather than resets", async () => {
    const f = fixture();
    await init(f);
    await ingest(f, 5, f.clock.now());
    f.clock.advance(SNAPSHOT_MIN_INTERVAL_MS + 1000);
    await ingest(f, 5, f.clock.now());

    const restarted = f.restart();
    const status = await jsonOf(await restarted.fetch(internal("/internal/status", TOKEN)));
    expect((status["phone"] as { rateHz: number }).rateHz).toBeGreaterThan(0);

    const body = await jsonOf(
      await restarted.fetch(
        internal("/internal/mcp", TOKEN, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "motion_summarize_session" },
        }),
      ),
    );
    const structured = (body["result"] as Record<string, unknown>)[
      "structuredContent"
    ] as Record<string, unknown>;
    expect(structured["samples"]).toBe(10);
  });

  it("arms the TTL alarm on a restart even without new activity", async () => {
    const f = fixture();
    await init(f);
    const armed = f.storage.alarmAtMs;
    f.storage.alarmAtMs = null;
    const restarted = f.restart();
    await restarted.fetch(internal("/internal/status", TOKEN));
    expect(f.storage.alarmAtMs).toBe(armed);
  });

  it("does not restore frames older than the ring window", async () => {
    const f = fixture();
    await init(f);
    await ingest(f, 5, f.clock.now());
    f.clock.advance(31 * 60 * 1000);
    const restarted = f.restart();
    const status = await jsonOf(await restarted.fetch(internal("/internal/status", TOKEN)));
    expect((status["phone"] as { rateHz: number | null }).rateHz).toBeNull();
  });

  it("keeps the snapshot small enough for a storage value", async () => {
    const f = fixture();
    await init(f);
    for (let i = 0; i < 200; i++) {
      await ingest(f, 25, f.clock.now());
      // Stay under the ingest limit and force a snapshot each time.
      f.clock.advance(SNAPSHOT_MIN_INTERVAL_MS + 1);
    }
    expect(f.storage.byteLength("ring")).toBeLessThan(100 * 1024);
  });

  it("writes nothing but its own two keys", async () => {
    const f = fixture();
    await init(f);
    await ingest(f, 5, f.clock.now());
    expect(f.storage.keys()).toEqual(["meta", "ring"]);
  });
});

describe("MotionSession — erasure", () => {
  it("wipes immediately on end and then behaves like an unknown session", async () => {
    const f = fixture();
    await init(f);
    await ingest(f, 5, f.clock.now());
    const ended = await f.session.fetch(internal("/internal/end", TOKEN, {}));
    expect(ended.status).toBe(200);
    expect(await jsonOf(ended)).toEqual({ erased: true });
    expect(f.storage.size()).toBe(0);
    expect(f.storage.alarmAtMs).toBeNull();

    for (const path of ["/internal/status", "/internal/end"]) {
      const response = await f.session.fetch(
        path === "/internal/status"
          ? internal(path, TOKEN)
          : internal(path, TOKEN, {}),
      );
      expect(response.status).toBe(404);
      expect(await jsonOf(response)).toEqual({ error: "unknown session" });
    }
  });

  it("wipes when the idle TTL alarm fires", async () => {
    const f = fixture();
    await init(f);
    await ingest(f, 5, f.clock.now());
    expect(f.storage.size()).toBeGreaterThan(0);

    f.clock.advance(SESSION_TTL_MS + 1);
    await f.session.alarm();
    expect(f.storage.size()).toBe(0);
    expect(f.storage.deleteAllCalls).toBeGreaterThan(0);
    expect((await f.session.fetch(internal("/internal/status", TOKEN))).status).toBe(404);
  });

  it("re-arms instead of wiping when the alarm fires early", async () => {
    const f = fixture();
    await init(f);
    f.clock.advance(30_000);
    await ingest(f, 5, f.clock.now());
    const lastActivity = f.clock.now();

    // The alarm was armed before that ingest, so it fires ahead of the deadline.
    f.clock.set(lastActivity + SESSION_TTL_MS - 30_000);
    await f.session.alarm();
    expect(f.storage.deleteAllCalls).toBe(0);
    expect(f.storage.alarmAtMs).toBe(lastActivity + SESSION_TTL_MS);

    f.clock.set(lastActivity + SESSION_TTL_MS + 1);
    await f.session.alarm();
    expect(f.storage.size()).toBe(0);
  });

  it("wipes an alarm that fires on an object with no metadata", async () => {
    const f = fixture();
    await f.session.alarm();
    expect(f.storage.size()).toBe(0);
  });
});
