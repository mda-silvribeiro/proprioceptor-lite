// MCP JSON-RPC dispatch, per docs/CONTRACTS.md § MCP (Streamable HTTP, stateless).
//
// `handle` is a pure function of (request, ctx): no sessions, no `Mcp-Session-Id`,
// no server-initiated stream. That is why COLD CALLS ARE LEGAL here — a
// `tools/list` or `tools/call` that arrives without a prior `initialize` is
// served normally, because there is no handshake state for it to be missing.
// claude.ai may reconnect, retry or fan out across isolates at any time; a
// stateless dispatcher makes all of those indistinguishable from the first call.

import type { MotionState, OrientationState, SessionSummary } from "./types";
import { renderMotionState, renderOrientationState, renderSessionSummary } from "./text";

export const SERVER_NAME = "proprioceptor-lite";
export const SERVER_VERSION = "0.1.0";
/**
 * Only `2025-06-18` is advertised. That revision removed JSON-RPC batching from
 * the MCP wire schema, which is why `handle` rejecting a batch array is
 * spec-legal here; advertising an older revision (e.g. `2025-03-26`) that still
 * carries batch message types while refusing them would be a conformance lie.
 * Any other requested version negotiates down to this one (index 0).
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18"] as const;
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_PARSE_ERROR = -32700;

export type JsonRpcId = string | number | null;

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Everything the dispatcher is allowed to know about the session. */
export interface McpContext {
  state(): MotionState;
  orientation(): OrientationState;
  summary(): SessionSummary;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, never>; additionalProperties: false };
}

/** v1 tools take no arguments; the strict schema says so explicitly. */
const NO_ARGS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** Tool names are a stability contract — see the contracts document. */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "motion_get_current_state",
    title: "Get current motion state",
    description:
      "Current interpreted motion state of the paired phone: freshness, orientation, " +
      "activity (stationary/walking/running/unknown), cadence and confidence. " +
      "Missing data is null, never a fabricated zero.",
    inputSchema: NO_ARGS,
  },
  {
    name: "motion_get_orientation",
    title: "Get device orientation",
    description:
      "Just the phone's latest orientation (heading, pitch, roll) and how old it is. " +
      "Null when nothing with a full orientation arrived in the last 3 seconds.",
    inputSchema: NO_ARGS,
  },
  {
    name: "motion_summarize_session",
    title: "Summarize the session so far",
    description:
      "Summary over the whole retained window (at most 30 minutes): sample count, " +
      "moving/stationary/unclassified shares, average cadence, heading range and " +
      "merged activity bouts, newest last.",
    inputSchema: NO_ARGS,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON-RPC 2.0 ids are strings or numbers; an explicit null is tolerated. */
function isId(value: unknown): value is JsonRpcId {
  if (value === null) return true;
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function success(id: JsonRpcId, result: Record<string, unknown>): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A tool result carries BOTH shapes: structured for code, text for the model. */
function toolResult(structured: Record<string, unknown>, text: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

function negotiateVersion(params: unknown): string {
  const requested = isRecord(params) ? params["protocolVersion"] : undefined;
  if (typeof requested === "string") {
    for (const supported of SUPPORTED_PROTOCOL_VERSIONS) {
      if (supported === requested) return requested;
    }
  }
  return DEFAULT_PROTOCOL_VERSION;
}

function callTool(id: JsonRpcId, params: unknown, ctx: McpContext): JsonRpcResponse {
  if (!isRecord(params)) return failure(id, JSONRPC_INVALID_PARAMS, "params must be an object");
  const name = params["name"];
  if (typeof name !== "string") {
    return failure(id, JSONRPC_INVALID_PARAMS, "params.name must be a string");
  }
  // `params.arguments` is ignored rather than rejected: v1 tools declare an
  // empty strict schema, no code path reads arguments, and a client that sends
  // an empty object (or none) must behave identically.
  switch (name) {
    case "motion_get_current_state": {
      const state = ctx.state();
      return success(id, toolResult(asRecord(state), renderMotionState(state)));
    }
    case "motion_get_orientation": {
      const orientation = ctx.orientation();
      return success(id, toolResult(asRecord(orientation), renderOrientationState(orientation)));
    }
    case "motion_summarize_session": {
      const summary = ctx.summary();
      return success(id, toolResult(asRecord(summary), renderSessionSummary(summary)));
    }
    default:
      return failure(id, JSONRPC_INVALID_PARAMS, "unknown tool");
  }
}

/**
 * Widen one of our own typed payloads to the `Record<string, unknown>` the
 * JSON-RPC envelope carries. Not a cast through `any`: interfaces with only
 * JSON-compatible members are structurally assignable to an index signature
 * only via an explicit spread, which is what this does.
 */
function asRecord(value: object): Record<string, unknown> {
  return { ...value };
}

/**
 * Dispatch a single JSON-RPC message. Returns null for notifications, which the
 * transport answers with an empty 202.
 */
export function handle(request: unknown, ctx: McpContext): JsonRpcResponse | null {
  // JSON-RPC batching is not offered: 2025-06-18 removed it, and a stateless
  // single-message server has nothing to gain from it.
  if (!isRecord(request)) {
    return failure(null, JSONRPC_INVALID_REQUEST, "request must be a JSON-RPC 2.0 object");
  }

  const rawId = request["id"];
  const id: JsonRpcId = isId(rawId) ? rawId : null;
  const method = request["method"];

  if (request["jsonrpc"] !== "2.0") {
    return failure(id, JSONRPC_INVALID_REQUEST, "jsonrpc must be 2.0");
  }
  if (typeof method !== "string") {
    return failure(id, JSONRPC_INVALID_REQUEST, "method must be a string");
  }
  if (rawId !== undefined && !isId(rawId)) {
    return failure(null, JSONRPC_INVALID_REQUEST, "id must be a string, a number, or absent");
  }

  // Notifications carry no id and get no response at all. `notifications/*` is
  // treated as a notification even when a client attaches an id to it, because
  // the correct answer is still "nothing".
  if (rawId === undefined || method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return success(id, {
        protocolVersion: negotiateVersion(request["params"]),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Motion state streamed from a phone browser. Call motion_get_current_state for " +
          "the latest reading, motion_get_orientation for heading/pitch/roll only, and " +
          "motion_summarize_session for the retained window. Null means the data does not " +
          "exist — do not treat it as zero. Nothing here contains a location.",
      });
    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, { tools: TOOLS });
    case "tools/call":
      return callTool(id, request["params"], ctx);
    default:
      return failure(id, JSONRPC_METHOD_NOT_FOUND, "method not found");
  }
}
