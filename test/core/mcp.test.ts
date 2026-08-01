import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROTOCOL_VERSION,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  SERVER_NAME,
  TOOLS,
  handle,
  type JsonRpcResponse,
  type McpContext,
} from "../../src/core/mcp";
import type { MotionState, OrientationState, SessionSummary } from "../../src/core/types";

const STATE: MotionState = {
  freshSeconds: 1.8,
  orientation: { headingDeg: 123.4, pitchDeg: -12, rollDeg: 4.2, headingAbsolute: true },
  activity: "walking",
  cadenceSpm: 112,
  confidence: 0.9,
  samples: { count: 412, windowSeconds: 240 },
  session: { ageSeconds: 610, expiresInSeconds: 3010 },
};

const ORIENTATION: OrientationState = {
  freshSeconds: STATE.freshSeconds,
  orientation: STATE.orientation,
};

const SUMMARY: SessionSummary = {
  windowSeconds: 240,
  samples: 412,
  movingPercent: 62.5,
  stationaryPercent: 30,
  unknownPercent: 7.5,
  avgCadenceSpm: 110,
  headingRangeDeg: { min: 12, max: 305 },
  activityBouts: [{ activity: "walking", startOffsetS: 0, durationS: 120 }],
};

function context(): McpContext {
  return {
    state: () => STATE,
    orientation: () => ORIENTATION,
    summary: () => SUMMARY,
  };
}

function call(request: unknown): JsonRpcResponse {
  const response = handle(request, context());
  if (response === null) throw new Error("expected a response, got a notification");
  return response;
}

function result(request: unknown): Record<string, unknown> {
  const response = call(request);
  if (!("result" in response)) throw new Error(`expected success, got ${JSON.stringify(response)}`);
  return response.result;
}

function errorOf(request: unknown): { code: number; message: string } {
  const response = call(request);
  if (!("error" in response)) throw new Error(`expected error, got ${JSON.stringify(response)}`);
  return response.error;
}

function toolCall(name: string, id: string | number = 1): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } };
}

describe("initialize", () => {
  it("completes the claude.ai-style handshake end to end", () => {
    const initialize = result({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-ai", version: "1.0" },
      },
    });
    expect(initialize["protocolVersion"]).toBe("2025-06-18");
    expect(initialize["capabilities"]).toEqual({ tools: {} });
    expect(initialize["serverInfo"]).toMatchObject({ name: SERVER_NAME });

    // The initialized notification is answered with nothing.
    expect(handle({ jsonrpc: "2.0", method: "notifications/initialized" }, context())).toBeNull();

    const listed = result({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = listed["tools"];
    expect(Array.isArray(tools)).toBe(true);
    expect((tools as { name: string }[]).map((t) => t.name)).toEqual([
      "motion_get_current_state",
      "motion_get_orientation",
      "motion_summarize_session",
    ]);

    const called = result(toolCall("motion_get_current_state", 2));
    expect(called["structuredContent"]).toEqual(STATE);
  });

  it("echoes a supported protocol version", () => {
    for (const version of ["2025-06-18"]) {
      const res = result({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: version },
      });
      expect(res["protocolVersion"]).toBe(version);
    }
  });

  it("negotiates down to the default for anything unsupported or absent", () => {
    for (const params of [
      // 2025-03-26 is deliberately no longer advertised: it still carries
      // JSON-RPC batching, which this server does not offer, so it negotiates
      // down rather than being echoed back.
      { protocolVersion: "2025-03-26" },
      { protocolVersion: "1999-01-01" },
      { protocolVersion: 20250618 },
      { protocolVersion: null },
      {},
      undefined,
    ]) {
      const res = result({ jsonrpc: "2.0", id: 1, method: "initialize", params });
      expect(res["protocolVersion"]).toBe(DEFAULT_PROTOCOL_VERSION);
    }
  });
});

describe("tools/list", () => {
  it("declares a strict empty input schema for every tool", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("cold calls are legal (stateless server)", () => {
  it("serves tools/list with no prior initialize", () => {
    const listed = result({ jsonrpc: "2.0", id: "cold-1", method: "tools/list" });
    expect(Array.isArray(listed["tools"])).toBe(true);
  });

  it("serves tools/call with no prior initialize", () => {
    for (const name of [
      "motion_get_current_state",
      "motion_get_orientation",
      "motion_summarize_session",
    ]) {
      const res = result(toolCall(name, `cold-${name}`));
      expect(res["structuredContent"]).toBeDefined();
    }
  });

  it("answers ping with no prior initialize", () => {
    expect(result({ jsonrpc: "2.0", id: 9, method: "ping" })).toEqual({});
  });
});

describe("tools/call results carry both shapes", () => {
  const expectations: [string, unknown][] = [
    ["motion_get_current_state", STATE],
    ["motion_get_orientation", ORIENTATION],
    ["motion_summarize_session", SUMMARY],
  ];

  for (const [name, structured] of expectations) {
    it(`${name} returns structuredContent and a text rendering`, () => {
      const res = result(toolCall(name));
      expect(res["structuredContent"]).toEqual(structured);
      const content = res["content"];
      expect(Array.isArray(content)).toBe(true);
      const first = (content as { type: string; text: string }[])[0];
      expect(first?.type).toBe("text");
      expect(typeof first?.text).toBe("string");
      expect((first?.text ?? "").length).toBeGreaterThan(0);
    });
  }

  it("ignores an arguments object rather than failing the call", () => {
    const res = result({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "motion_get_orientation", arguments: { unexpected: true } },
    });
    expect(res["structuredContent"]).toEqual(ORIENTATION);
  });

  it("works with no arguments key at all", () => {
    const res = result({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "motion_get_orientation" },
    });
    expect(res["structuredContent"]).toEqual(ORIENTATION);
  });
});

describe("errors", () => {
  it("unknown method is -32601", () => {
    expect(errorOf({ jsonrpc: "2.0", id: 1, method: "resources/list" }).code).toBe(
      JSONRPC_METHOD_NOT_FOUND,
    );
  });

  it("unknown tool is -32602", () => {
    expect(errorOf(toolCall("motion_get_location")).code).toBe(JSONRPC_INVALID_PARAMS);
  });

  it("bad tools/call params is -32602", () => {
    for (const params of [undefined, null, "x", [], { name: 5 }]) {
      expect(errorOf({ jsonrpc: "2.0", id: 1, method: "tools/call", params }).code).toBe(
        JSONRPC_INVALID_PARAMS,
      );
    }
  });

  it("malformed envelopes are -32600", () => {
    const malformed: unknown[] = [
      null,
      "not json-rpc",
      42,
      [],
      [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      { id: 1, method: "ping" },
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: 1, method: 7 },
      { jsonrpc: "2.0", id: true, method: "ping" },
      { jsonrpc: "2.0", id: {}, method: "ping" },
    ];
    for (const request of malformed) {
      expect(errorOf(request).code).toBe(JSONRPC_INVALID_REQUEST);
    }
  });

  it("echoes the id when it is usable and uses null when it is not", () => {
    const withId = call({ jsonrpc: "2.0", id: "abc", method: "nope" });
    expect(withId.id).toBe("abc");
    const withoutId = call({ jsonrpc: "1.0", id: true, method: "ping" });
    expect(withoutId.id).toBeNull();
  });

  it("tolerates an explicit null id", () => {
    expect(call({ jsonrpc: "2.0", id: null, method: "ping" }).id).toBeNull();
  });
});

describe("notifications", () => {
  it("returns null for anything without an id", () => {
    for (const method of ["notifications/initialized", "notifications/cancelled", "ping"]) {
      expect(handle({ jsonrpc: "2.0", method }, context())).toBeNull();
    }
  });

  it("returns null for notifications/* even when a client attaches an id", () => {
    expect(handle({ jsonrpc: "2.0", id: 5, method: "notifications/initialized" }, context()),
    ).toBeNull();
  });
});

describe("purity", () => {
  it("does not mutate the payloads it is handed", () => {
    const before = JSON.stringify(STATE);
    result(toolCall("motion_get_current_state"));
    expect(JSON.stringify(STATE)).toBe(before);
  });

  it("is stateless: repeated identical calls give identical answers", () => {
    const a = result(toolCall("motion_summarize_session"));
    const b = result(toolCall("motion_summarize_session"));
    expect(a).toEqual(b);
  });
});
