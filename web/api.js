/**
 * Typed wrappers over the HTTP surface in docs/CONTRACTS.md.
 *
 * Every wrapper returns a *validated* value or throws {@link ApiError}. Nothing
 * here trusts the response body: a malformed payload is a protocol failure, not
 * a runtime crash three frames later. The types below mirror
 * `src/core/types.ts`; `web/` deliberately imports nothing from `src/` so the
 * page stays a standalone, buildless bundle of ES modules.
 */

/**
 * One sensor frame, exactly as the server validates it. Absent readings are
 * `null` — never 0. See docs/CONTRACTS.md § Frame.
 * @typedef {object} Frame
 * @property {number} tMs           phone epoch ms; ordering/cadence only
 * @property {number|null} headingDeg  [0,360)
 * @property {number|null} pitchDeg    [-90,90]
 * @property {number|null} rollDeg     [-180,180]
 * @property {boolean} headingAbsolute true only for a compass-referenced heading
 * @property {number|null} aMag        |accelerationIncludingGravity| in m/s², [0,80]
 */

/**
 * @typedef {object} SessionInfo
 * @property {string} token
 * @property {string} code
 * @property {string} mcpPath
 * @property {number} expiresInS
 */

/**
 * @typedef {object} Status
 * @property {{streaming: boolean, rateHz: number|null, lastFrameAgeS: number|null}} phone
 * @property {{totalCalls: number, lastCallAgeS: number|null}} mcp
 * @property {{ageS: number, expiresInS: number}} session
 */

/**
 * `gone`          — 404; uniform "unknown session" per contract
 * `rate-limited`  — 429; `retryAfterS` is authoritative
 * `invalid`       — 422; we sent something the schema rejects (a bug on our side)
 * `network`       — fetch never completed (offline, DNS, abort)
 * `server`        — 5xx or any other unexpected status
 * `protocol`      — 2xx with a body that isn't the documented shape
 * @typedef {"gone"|"rate-limited"|"invalid"|"network"|"server"|"protocol"} ApiFailureKind
 */

/** The single message shown for every 404 on an existing session. */
export const SESSION_GONE_MESSAGE =
  "That session is gone — it expired or was erased. Nothing was kept. Start a new one.";

/**
 * Wrong code, already-used code and expired code are one message on purpose:
 * the server refuses to distinguish them (docs/CONTRACTS.md § Identity and
 * pairing) and the UI must not leak the difference either.
 */
export const CODE_REJECTED_MESSAGE =
  "That code didn't work. Codes are single-use and expire five minutes after they appear — start a new session on the other device for a fresh one.";

/** Fetch gives up after this long; a hung request must not stall the stream. */
const REQUEST_TIMEOUT_MS = 8000;

/** Fallback when a 429 arrives without a usable Retry-After. */
const DEFAULT_RETRY_AFTER_S = 5;

export class ApiError extends Error {
  /**
   * @param {ApiFailureKind} kind
   * @param {string} message  user-facing, already honest about what we know
   * @param {number|null} [status]
   * @param {number|null} [retryAfterS]
   */
  constructor(kind, message, status = null, retryAfterS = null) {
    super(message);
    this.name = "ApiError";
    /** @type {ApiFailureKind} */
    this.kind = kind;
    /** @type {number|null} */
    this.status = status;
    /** @type {number|null} */
    this.retryAfterS = retryAfterS;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Finite check first, then range — `NaN` must fail closed exactly like the
 * server-side gate does.
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

/**
 * Retry-After is defined as either delta-seconds or an HTTP date. We honour
 * both and clamp: a hostile or broken value must not park the UI for an hour.
 * @param {Headers} headers
 * @returns {number}
 */
export function parseRetryAfter(headers) {
  const raw = headers.get("Retry-After");
  if (raw === null) return DEFAULT_RETRY_AFTER_S;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 300);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    const delta = Math.ceil((when - Date.now()) / 1000);
    if (delta > 0) return Math.min(delta, 300);
  }
  return DEFAULT_RETRY_AFTER_S;
}

/**
 * Capped exponential backoff, no jitter: one client per session means there is
 * no herd to spread out, and determinism makes the behaviour testable.
 * @param {number} attempt 1-based
 * @returns {number} milliseconds
 */
export function backoffDelayMs(attempt) {
  const base = 1000;
  const cap = 15000;
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  return Math.min(base * 2 ** exponent, cap);
}

/**
 * @param {string} path
 * @param {"GET"|"POST"} method
 * @param {object|null} body
 * @param {string} goneMessage
 * @returns {Promise<unknown>}
 */
async function request(path, method, body, goneMessage) {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(path, {
      method,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      headers: body === null ? { accept: "application/json" } : {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: body === null ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError("network", "Couldn't reach the server.", null, null);
  }

  if (response.status === 404) throw new ApiError("gone", goneMessage, 404, null);
  if (response.status === 429) {
    const retryAfterS = parseRetryAfter(response.headers);
    throw new ApiError(
      "rate-limited",
      `Rate limit reached — pausing ${retryAfterS} s.`,
      429,
      retryAfterS,
    );
  }
  if (response.status === 422) {
    throw new ApiError("invalid", "The server rejected that data as invalid.", 422, null);
  }
  if (!response.ok) {
    throw new ApiError("server", `Server error (${response.status}).`, response.status, null);
  }

  // 202 with an empty body is legal elsewhere in the contract; treat an empty
  // 2xx as `null` and let each parser decide whether that is acceptable.
  const raw = await response.text().catch(() => "");
  if (raw.trim() === "") return null;
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    throw new ApiError("protocol", "The server sent a response we couldn't read.", response.status);
  }
}

/**
 * @param {unknown} value
 * @returns {SessionInfo}
 */
function parseSessionInfo(value) {
  if (!isRecord(value)) throw new ApiError("protocol", "Unexpected session response.");
  const { token, code, mcpPath, expiresInS } = value;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(token)) {
    throw new ApiError("protocol", "Unexpected session response (token).");
  }
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) {
    throw new ApiError("protocol", "Unexpected session response (code).");
  }
  return {
    token,
    code,
    mcpPath: typeof mcpPath === "string" && mcpPath.startsWith("/") ? mcpPath : `/mcp/${token}`,
    expiresInS: isFiniteNumber(expiresInS) && expiresInS > 0 ? expiresInS : 300,
  };
}

/**
 * @param {unknown} value
 * @returns {Status}
 */
function parseStatus(value) {
  if (!isRecord(value)) throw new ApiError("protocol", "Unexpected status response.");
  const phone = isRecord(value["phone"]) ? value["phone"] : {};
  const mcp = isRecord(value["mcp"]) ? value["mcp"] : {};
  const session = isRecord(value["session"]) ? value["session"] : {};
  return {
    phone: {
      streaming: phone["streaming"] === true,
      rateHz: finiteOrNull(phone["rateHz"]),
      lastFrameAgeS: finiteOrNull(phone["lastFrameAgeS"]),
    },
    mcp: {
      totalCalls: finiteOrNull(mcp["totalCalls"]) ?? 0,
      lastCallAgeS: finiteOrNull(mcp["lastCallAgeS"]),
    },
    session: {
      ageS: finiteOrNull(session["ageS"]) ?? 0,
      expiresInS: finiteOrNull(session["expiresInS"]) ?? 0,
    },
  };
}

/** @returns {Promise<SessionInfo>} */
export async function createSession() {
  const body = await request(
    "/api/session",
    "POST",
    {},
    "Couldn't create a session right now — try again in a moment.",
  );
  return parseSessionInfo(body);
}

/**
 * @param {string} code six decimal digits
 * @returns {Promise<string>} the session token
 */
export async function claimCode(code) {
  const body = await request("/api/claim", "POST", { code }, CODE_REJECTED_MESSAGE);
  if (!isRecord(body)) throw new ApiError("protocol", "Unexpected claim response.");
  const token = body["token"];
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(token)) {
    throw new ApiError("protocol", "Unexpected claim response (token).");
  }
  return token;
}

/**
 * @param {string} token
 * @param {readonly Frame[]} frames  caller guarantees ≤ 25 (contract limit)
 * @returns {Promise<number>} frames the server accepted
 */
export async function postFrames(token, frames) {
  const body = await request(
    `/ingest/${encodeURIComponent(token)}`,
    "POST",
    { frames },
    SESSION_GONE_MESSAGE,
  );
  if (!isRecord(body)) throw new ApiError("protocol", "Unexpected ingest response.");
  const accepted = body["accepted"];
  return isFiniteNumber(accepted) ? accepted : 0;
}

/**
 * @param {string} token
 * @returns {Promise<Status>}
 */
export async function getStatus(token) {
  const body = await request(
    `/status/${encodeURIComponent(token)}`,
    "GET",
    null,
    SESSION_GONE_MESSAGE,
  );
  return parseStatus(body);
}

/**
 * @param {string} token
 * @returns {Promise<void>} resolves once the session is gone — a 404 counts,
 *   since "already erased" is the outcome the user asked for.
 */
export async function endSession(token) {
  try {
    await request(`/api/end/${encodeURIComponent(token)}`, "POST", {}, SESSION_GONE_MESSAGE);
  } catch (error) {
    if (error instanceof ApiError && error.kind === "gone") return;
    throw error;
  }
}

/**
 * The MCP connector URL the user pastes into claude.ai. Derived from the page's
 * own origin so a self-deployed Worker on any hostname just works.
 * @param {string} origin
 * @param {string} mcpPath
 * @returns {string}
 */
export function connectorUrl(origin, mcpPath) {
  return `${origin}${mcpPath}`;
}
