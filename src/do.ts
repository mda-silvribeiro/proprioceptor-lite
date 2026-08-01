// Durable Objects: the pairing Lobby and the per-token MotionSession.
//
// Everything stateful lives here; nothing is written outside these objects.
// Both classes are reachable only through internal routes called by the Worker
// (src/worker.ts), never directly from the network.
//
// The storage surface is declared locally as `DoStorage` rather than imported
// from workers-types, for two reasons: it documents exactly which storage
// operations this project performs, and it lets both classes be constructed with
// an in-memory shim under plain Node so their behaviour is unit-testable.

import {
  FrameRing,
  RING_CAP,
  RING_WINDOW_MS,
  type RingEntry,
  decodeEntries,
  encodeEntries,
} from "./core/ring";
import { validateBatch } from "./core/validate";
import { buildMotionState, buildOrientationState, buildSessionSummary } from "./core/state";
import { handle as handleMcp, type McpContext } from "./core/mcp";
import { constantTimeEqual, isCodeShaped, isTokenShaped, mintCode, mintToken } from "./core/tokens";
import type { Status } from "./core/types";

/* ── Contract constants (docs/CONTRACTS.md) ─────────────────────────────── */

/** Idle TTL: no ingest AND no MCP call for this long ⇒ storage.deleteAll(). */
export const SESSION_TTL_MS = 60 * 60 * 1000;
export const CODE_TTL_MS = 300_000;
export const CODE_MAX_ATTEMPTS = 10;
export const LOBBY_MINT_LIMIT = 10;
export const LOBBY_MINT_WINDOW_MS = 10 * 60 * 1000;
export const INGEST_LIMIT = 15;
export const INGEST_WINDOW_MS = 10_000;
export const MCP_LIMIT = 60;
export const MCP_WINDOW_MS = 60_000;

/* ── Implementation choices, documented ─────────────────────────────────── */

/** Snapshot at most this often: the ring is a cache, not a record of truth. */
export const SNAPSHOT_MIN_INTERVAL_MS = 30_000;
/**
 * Only the newest frames are snapshotted. A Durable Object storage value is
 * size-bounded, and 9 000 encoded frames would exceed it; ~1 200 keeps the
 * value comfortably small while covering the classification window and several
 * minutes of history, so an isolate restart resumes rather than resets.
 */
export const SNAPSHOT_MAX_ENTRIES = 1200;
/** Re-arm the TTL alarm only when the deadline has moved by more than this. */
export const ALARM_SLACK_MS = 60_000;
/** `phone.streaming` is true while frames are arriving this recently. */
export const STREAMING_MAX_AGE_S = 5;
/** Window used for the reported ingest rate. */
export const RATE_WINDOW_S = 10;

export const TOKEN_HEADER = "x-session-token";

/* ── Local storage surface ──────────────────────────────────────────────── */

/** The slice of DurableObjectStorage this project uses. */
export interface DoStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DoState {
  readonly storage: DoStorage;
}

export interface DoDeps {
  /** Injectable clock; production uses Date.now. */
  now?: () => number;
}

/* ── Small helpers ──────────────────────────────────────────────────────── */

const JSON_HEADERS: Record<string, string> = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (extra !== undefined) Object.assign(headers, extra);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Uniform failure for every unknown, expired or wiped session. Bad token and
 * expired session are deliberately indistinguishable, per the contract.
 */
function notFound(): Response {
  return json({ error: "unknown session" }, 404);
}

function rateLimited(retryAfterS: number): Response {
  // Inverted gate: a non-finite delay must degrade to 1 s, never to "NaN".
  const seconds = Number.isFinite(retryAfterS) ? Math.max(1, Math.ceil(retryAfterS)) : 1;
  return json({ error: "rate limited" }, 429, { "Retry-After": String(seconds) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An empty body is treated as `{}`: several endpoints take no meaningful body. */
function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim().length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function nonNegative(x: number): number {
  return x > 0 ? x : 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Fixed-window rate limiter, held in memory. Rate-limit state deliberately does
 * not survive an isolate restart: it exists to bound cost and abuse in the
 * common case, and persisting a counter per request would cost a storage write
 * on the hot path. A rejected request does not extend its own window.
 */
export class FixedWindow {
  private readonly limit: number;
  private readonly windowMs: number;
  private windowStartMs = -Infinity;
  private used = 0;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  take(nowMs: number): { ok: true } | { ok: false; retryAfterS: number } {
    if (!(nowMs - this.windowStartMs < this.windowMs)) {
      this.windowStartMs = nowMs;
      this.used = 0;
    }
    if (this.used >= this.limit) {
      const remainMs = this.windowStartMs + this.windowMs - nowMs;
      return { ok: false, retryAfterS: Math.max(1, Math.ceil(remainMs / 1000)) };
    }
    this.used++;
    return { ok: true };
  }
}

/* ── Lobby ──────────────────────────────────────────────────────────────── */

interface CodeRecord {
  token: string;
  expiresAtMs: number;
  attempts: number;
}

interface LobbyBook {
  codes: Record<string, CodeRecord>;
  /** Epoch ms of recent mints, for the global new-session rate limit. */
  mints: number[];
}

const LOBBY_KEY = "book";

function decodeBook(value: unknown): LobbyBook {
  const book: LobbyBook = { codes: {}, mints: [] };
  if (!isRecord(value)) return book;

  const codes = value["codes"];
  if (isRecord(codes)) {
    for (const [code, record] of Object.entries(codes)) {
      if (!isCodeShaped(code) || !isRecord(record)) continue;
      const token = record["token"];
      const expiresAtMs = finiteNumber(record["expiresAtMs"]);
      const attempts = finiteNumber(record["attempts"]);
      if (!isTokenShaped(token) || expiresAtMs === null) continue;
      book.codes[code] = { token, expiresAtMs, attempts: attempts ?? 0 };
    }
  }

  const mints = value["mints"];
  if (Array.isArray(mints)) {
    for (const t of mints) {
      const ms = finiteNumber(t);
      if (ms !== null) book.mints.push(ms);
    }
  }
  return book;
}

/**
 * Singleton (`idFromName("lobby")`). Mints sessions and trades a 6-digit code
 * for its token exactly once. Codes are persisted so an isolate restart does
 * not break a pairing that is mid-flight.
 */
export class Lobby {
  private readonly storage: DoStorage;
  private readonly clock: () => number;

  constructor(state: DoState, _env: unknown, deps: DoDeps = {}) {
    this.storage = state.storage;
    this.clock = deps.now ?? (() => Date.now());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (url.pathname === "/internal/mint") return await this.mint();
    if (url.pathname === "/internal/claim") return await this.claim(request);
    return json({ error: "not found" }, 404);
  }

  private async load(): Promise<LobbyBook> {
    return decodeBook(await this.storage.get<unknown>(LOBBY_KEY));
  }

  private async save(book: LobbyBook): Promise<void> {
    await this.storage.put(LOBBY_KEY, book);
  }

  private prune(book: LobbyBook, nowMs: number): void {
    for (const [code, record] of Object.entries(book.codes)) {
      if (!(record.expiresAtMs > nowMs)) delete book.codes[code];
    }
  }

  /**
   * A failed claim is charged against every code that is currently outstanding.
   * A wrong guess names no record, so it cannot be attributed to one; charging
   * all live codes is what makes "at most 10 failed claim attempts before the
   * code is invalidated" implementable. With the global mint limit there are at
   * most ~10 live codes, so the blast radius is small, and 10 guesses against a
   * 10^6 code space is the brute-force bound the contract is after.
   */
  private chargeFailure(book: LobbyBook): void {
    for (const [code, record] of Object.entries(book.codes)) {
      record.attempts += 1;
      if (record.attempts >= CODE_MAX_ATTEMPTS) delete book.codes[code];
    }
  }

  private async mint(): Promise<Response> {
    const now = this.clock();
    const book = await this.load();
    this.prune(book, now);

    book.mints = book.mints.filter((t) => t > now - LOBBY_MINT_WINDOW_MS);
    if (book.mints.length >= LOBBY_MINT_LIMIT) {
      let oldest = Infinity;
      for (const t of book.mints) if (t < oldest) oldest = t;
      const remainMs = oldest + LOBBY_MINT_WINDOW_MS - now;
      await this.save(book);
      return rateLimited(Math.ceil(remainMs / 1000));
    }

    let code = mintCode();
    for (let i = 0; i < 100 && book.codes[code] !== undefined; i++) code = mintCode();
    if (book.codes[code] !== undefined) return json({ error: "unavailable" }, 503);

    const token = mintToken();
    book.codes[code] = { token, expiresAtMs: now + CODE_TTL_MS, attempts: 0 };
    book.mints.push(now);
    await this.save(book);

    // `expiresInS` is the pairing code's deadline — the only fixed countdown at
    // mint time. The session's own TTL is an idle timer that every ingest and
    // every MCP call re-arms, so it has no meaningful value to report here.
    return json({ token, code, mcpPath: `/mcp/${token}`, expiresInS: CODE_TTL_MS / 1000 });
  }

  private async claim(request: Request): Promise<Response> {
    const now = this.clock();
    const parsed = tryParse(await request.text());
    const submitted = parsed.ok && isRecord(parsed.value) ? parsed.value["code"] : undefined;

    const book = await this.load();
    this.prune(book, now);

    // A malformed code is rejected without charging an attempt: it cannot be a
    // guess at a real code, so letting it burn live codes would be a free DoS.
    if (!isCodeShaped(submitted)) {
      await this.save(book);
      return notFound();
    }

    let matched: string | null = null;
    for (const code of Object.keys(book.codes)) {
      if (constantTimeEqual(code, submitted)) matched = code;
    }
    const record = matched === null ? undefined : book.codes[matched];
    if (matched === null || record === undefined) {
      this.chargeFailure(book);
      await this.save(book);
      return notFound();
    }

    delete book.codes[matched]; // single use
    await this.save(book);
    return json({ token: record.token });
  }
}

/* ── MotionSession ──────────────────────────────────────────────────────── */

interface SessionMetaRecord {
  token: string;
  createdMs: number;
  /** Last ingest or MCP call; the idle TTL is measured from here. */
  lastActivityMs: number;
  lastFrameMs: number | null;
  lastCallMs: number | null;
  totalCalls: number;
}

const META_KEY = "meta";
const RING_KEY = "ring";

function decodeMeta(value: unknown): SessionMetaRecord | null {
  if (!isRecord(value)) return null;
  const token = value["token"];
  const createdMs = finiteNumber(value["createdMs"]);
  const lastActivityMs = finiteNumber(value["lastActivityMs"]);
  if (!isTokenShaped(token) || createdMs === null || lastActivityMs === null) return null;
  const totalCalls = finiteNumber(value["totalCalls"]);
  return {
    token,
    createdMs,
    lastActivityMs,
    lastFrameMs: finiteNumber(value["lastFrameMs"]),
    lastCallMs: finiteNumber(value["lastCallMs"]),
    totalCalls: totalCalls === null ? 0 : Math.max(0, Math.floor(totalCalls)),
  };
}

/**
 * One per token (`idFromName(token)`). Owns the ring, the counters behind
 * `Status`, the ingest/MCP rate limits, and the idle-TTL alarm.
 */
export class MotionSession {
  private readonly storage: DoStorage;
  private readonly clock: () => number;
  private readonly ingestLimit = new FixedWindow(INGEST_LIMIT, INGEST_WINDOW_MS);
  private readonly mcpLimit = new FixedWindow(MCP_LIMIT, MCP_WINDOW_MS);
  private ring = new FrameRing(RING_CAP, RING_WINDOW_MS);
  private meta: SessionMetaRecord | null = null;
  private loaded = false;
  private lastPersistMs = -Infinity;
  private armedForMs: number | null = null;

  constructor(state: DoState, _env: unknown, deps: DoDeps = {}) {
    this.storage = state.storage;
    this.clock = deps.now ?? (() => Date.now());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.load();

    switch (url.pathname) {
      case "/internal/init":
        return request.method === "POST" ? await this.init(request) : methodNotAllowed();
      case "/internal/ingest":
        return request.method === "POST" ? await this.ingest(request) : methodNotAllowed();
      case "/internal/status":
        return request.method === "GET" ? this.status(request) : methodNotAllowed();
      case "/internal/mcp":
        return request.method === "POST" ? await this.mcp(request) : methodNotAllowed();
      case "/internal/end":
        return request.method === "POST" ? await this.end(request) : methodNotAllowed();
      default:
        return json({ error: "not found" }, 404);
    }
  }

  /** TTL expiry. Fires at most ALARM_SLACK_MS early, hence the re-check. */
  async alarm(): Promise<void> {
    await this.load();
    const meta = this.meta;
    if (meta === null) {
      await this.wipe();
      return;
    }
    const due = meta.lastActivityMs + SESSION_TTL_MS;
    if (this.clock() < due) {
      this.armedForMs = due;
      await this.storage.setAlarm(due);
      return;
    }
    await this.wipe();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.meta = decodeMeta(await this.storage.get<unknown>(META_KEY));
    // Restoring a snapshot must not resurrect frames older than the ring's own
    // window: age eviction otherwise waits for the next push, and a session that
    // was idle for an hour would briefly serve half-hour-old motion as current.
    const cutoff = this.clock() - RING_WINDOW_MS;
    const restored = decodeEntries(await this.storage.get<unknown>(RING_KEY)).filter(
      (entry) => entry.recvMs >= cutoff,
    );
    this.ring = FrameRing.fromEntries(restored, RING_CAP, RING_WINDOW_MS);
    this.loaded = true;
    const meta = this.meta;
    if (meta !== null && this.armedForMs === null) {
      // One alarm write per isolate lifetime, so a restart cannot leave a live
      // session without a TTL.
      this.armedForMs = meta.lastActivityMs + SESSION_TTL_MS;
      await this.storage.setAlarm(this.armedForMs);
    }
  }

  /**
   * Constant-time check of the presented token against the one this object was
   * initialised with. An uninitialised object has no token, which is how a
   * fabricated token produces the same uniform 404 as an expired session.
   */
  private authorize(request: Request): SessionMetaRecord | null {
    const meta = this.meta;
    if (meta === null) return null;
    const presented = request.headers.get(TOKEN_HEADER) ?? "";
    if (!isTokenShaped(presented)) return null;
    if (!constantTimeEqual(meta.token, presented)) return null;
    return meta;
  }

  private async init(request: Request): Promise<Response> {
    const presented = request.headers.get(TOKEN_HEADER) ?? "";
    if (!isTokenShaped(presented)) return notFound();

    const existing = this.meta;
    if (existing !== null) {
      // Idempotent: re-initialising a live session must not reset its clocks.
      if (!constantTimeEqual(existing.token, presented)) return notFound();
      return json({ ok: true });
    }

    const now = this.clock();
    this.meta = {
      token: presented,
      createdMs: now,
      lastActivityMs: now,
      lastFrameMs: null,
      lastCallMs: null,
      totalCalls: 0,
    };
    await this.persist(true);
    return json({ ok: true });
  }

  private async ingest(request: Request): Promise<Response> {
    const meta = this.authorize(request);
    if (meta === null) return notFound();

    const now = this.clock();
    const allowed = this.ingestLimit.take(now);
    if (!allowed.ok) return rateLimited(allowed.retryAfterS);

    const parsed = tryParse(await request.text());
    if (!parsed.ok) return json({ error: "body must be valid JSON" }, 400);

    const validated = validateBatch(parsed.value);
    if (!validated.ok) return json({ error: validated.message }, validated.status);

    this.ring.push(validated.frames, now);
    if (validated.frames.length > 0) meta.lastFrameMs = now;
    // Only a successful ingest re-arms the TTL; a rejected batch must not keep
    // a dead session alive.
    meta.lastActivityMs = now;
    await this.persist(false);
    return json({ accepted: validated.frames.length });
  }

  /** Polling status does NOT re-arm the TTL — only ingest and MCP calls do. */
  private status(request: Request): Response {
    const meta = this.authorize(request);
    if (meta === null) return notFound();

    const now = this.clock();
    const lastFrameAgeS =
      meta.lastFrameMs === null ? null : round1(nonNegative((now - meta.lastFrameMs) / 1000));
    const body: Status = {
      phone: {
        streaming: lastFrameAgeS !== null && lastFrameAgeS <= STREAMING_MAX_AGE_S,
        rateHz:
          this.ring.count() === 0
            ? null
            : round1(this.ring.window(RATE_WINDOW_S, now).length / RATE_WINDOW_S),
        lastFrameAgeS,
      },
      mcp: {
        totalCalls: meta.totalCalls,
        lastCallAgeS:
          meta.lastCallMs === null ? null : round1(nonNegative((now - meta.lastCallMs) / 1000)),
      },
      session: {
        ageS: Math.round(nonNegative((now - meta.createdMs) / 1000)),
        expiresInS: Math.round(nonNegative(meta.lastActivityMs + SESSION_TTL_MS - now) / 1000),
      },
    };
    return json(body);
  }

  private async mcp(request: Request): Promise<Response> {
    const meta = this.authorize(request);
    if (meta === null) return notFound();

    const now = this.clock();
    const allowed = this.mcpLimit.take(now);
    if (!allowed.ok) return rateLimited(allowed.retryAfterS);

    // Captured before the call re-arms the idle timer, so `expiresInSeconds`
    // reports the deadline that was actually in force when the client asked.
    const expiresAtMs = meta.lastActivityMs + SESSION_TTL_MS;
    const createdMs = meta.createdMs;

    const parsed = tryParse(await request.text());
    meta.totalCalls += 1;
    meta.lastCallMs = now;
    meta.lastActivityMs = now;
    await this.persist(false);

    if (!parsed.ok) {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }

    // Materialise the ring lazily: initialize, ping, tools/list and every
    // notification never touch ctx, so they do zero ring work. Only a tools/call
    // reads it, and exactly one tool runs per request, so this is one snapshot
    // per call — and nothing mutates the ring between here and the synchronous
    // handleMcp below, so the snapshot a tool sees is unchanged.
    const entriesOf = (): RingEntry[] => this.ring.all();
    const ctx: McpContext = {
      state: () => buildMotionState(entriesOf(), { createdMs, expiresAtMs }, now),
      orientation: () => buildOrientationState(entriesOf(), now),
      summary: () => buildSessionSummary(entriesOf(), now),
    };
    const response = handleMcp(parsed.value, ctx);
    // A notification gets an empty 202 with no content type — there is no body
    // to describe. Per the contract's MCP section.
    if (response === null) return new Response(null, { status: 202 });
    return json(response);
  }

  private async end(request: Request): Promise<Response> {
    if (this.authorize(request) === null) return notFound();
    await this.wipe();
    return json({ erased: true });
  }

  private async persist(force: boolean): Promise<void> {
    const meta = this.meta;
    if (meta === null) return;
    const now = this.clock();
    if (!force && now - this.lastPersistMs < SNAPSHOT_MIN_INTERVAL_MS) return;
    this.lastPersistMs = now;

    await this.storage.put(META_KEY, meta);
    const entries = this.ring.all();
    const tail =
      entries.length > SNAPSHOT_MAX_ENTRIES
        ? entries.slice(entries.length - SNAPSHOT_MAX_ENTRIES)
        : entries;
    await this.storage.put(RING_KEY, encodeEntries(tail));

    const due = meta.lastActivityMs + SESSION_TTL_MS;
    if (this.armedForMs === null || due - this.armedForMs > ALARM_SLACK_MS) {
      this.armedForMs = due;
      await this.storage.setAlarm(due);
    }
  }

  private async wipe(): Promise<void> {
    await this.storage.deleteAll();
    await this.storage.deleteAlarm();
    this.meta = null;
    this.ring.clear();
    this.armedForMs = null;
    this.lastPersistMs = -Infinity;
    // Storage is known-empty, so a later request must not re-read it and must
    // answer with the uniform 404.
    this.loaded = true;
  }
}

function methodNotAllowed(): Response {
  return json({ error: "method not allowed" }, 405);
}
