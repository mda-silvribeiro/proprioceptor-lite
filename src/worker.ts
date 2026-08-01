// HTTP router. Routing, request hygiene and response headers only — every
// decision about pairing, frames, rate limits and MCP lives in the Durable
// Objects (src/do.ts) and the pure core (src/core/**).
//
// Endpoint table: docs/CONTRACTS.md § HTTP endpoints.

import { TOKEN_HEADER } from "./do";
import { isTokenShaped } from "./core/tokens";

// Workers requires Durable Object classes to be exported from the entry module.
export { Lobby, MotionSession } from "./do";

export interface Env {
  ASSETS: Fetcher;
  LOBBY: DurableObjectNamespace;
  MOTION_SESSION: DurableObjectNamespace;
}

/** Contract limit for any JSON body we accept. */
export const MAX_BODY_BYTES = 32 * 1024;
/** The Lobby is a singleton. */
export const LOBBY_NAME = "lobby";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const JSON_HEADERS: Record<string, string> = { "content-type": "application/json; charset=utf-8" };

/** Internal origin for DO sub-requests; never leaves the isolate. */
const INTERNAL_ORIGIN = "https://motion-session.internal";

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (extra !== undefined) Object.assign(headers, extra);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Uniform for a bad token, an expired session and a wiped one alike. */
function unknownSession(): Response {
  return json({ error: "unknown session" }, 404);
}

function notFound(): Response {
  return json({ error: "not found" }, 404);
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method not allowed" }, 405, { Allow: allow });
}

/**
 * Security headers on every response.
 *
 * No `Access-Control-Allow-*` header is ever set: the page is same-origin by
 * design, so a cross-origin caller must simply be refused by the browser, and
 * OPTIONS is answered 405 rather than as a preflight.
 *
 * No `Permissions-Policy` is set either — one that disabled `accelerometer`,
 * `gyroscope` or `magnetometer` would break the very sensors the page needs.
 *
 * CSP is attached only to HTML, which in production comes from the assets
 * binding; API responses are JSON and carry no document context.
 */
function harden(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "no-referrer");
  const contentType = (out.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html")) out.headers.set("Content-Security-Policy", CSP);
  return out;
}

type BodyResult = { ok: true; text: string } | { ok: false; response: Response };

/**
 * Read a request body under the contract's 32 KiB cap and JSON content type.
 * Content-Length is checked first so an oversized body can be refused before it
 * is buffered, and the actual byte count is checked again afterwards because a
 * chunked request may not declare one.
 */
async function readBody(request: Request): Promise<BodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) {
      return { ok: false, response: json({ error: "invalid content-length" }, 400) };
    }
    if (length > MAX_BODY_BYTES) {
      return { ok: false, response: json({ error: "payload too large" }, 413) };
    }
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase().trim();
  if (contentType.length > 0 && !contentType.startsWith("application/json")) {
    return { ok: false, response: json({ error: "content-type must be application/json" }, 415) };
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: "payload too large" }, 413) };
  }
  // A body with no declared type is refused; an absent body is not, because
  // POST /api/session and POST /api/end/<token> carry nothing to type.
  if (buffer.byteLength > 0 && contentType.length === 0) {
    return { ok: false, response: json({ error: "content-type must be application/json" }, 415) };
  }
  return { ok: true, text: new TextDecoder().decode(buffer) };
}

function internalRequest(
  path: string,
  method: string,
  token: string | null,
  body: string | null,
): Request {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (token !== null) headers[TOKEN_HEADER] = token;
  const url = `${INTERNAL_ORIGIN}${path}`;
  return body === null
    ? new Request(url, { method, headers })
    : new Request(url, { method, headers, body });
}

function lobbyStub(env: Env): DurableObjectStub {
  return env.LOBBY.get(env.LOBBY.idFromName(LOBBY_NAME));
}

function sessionStub(env: Env, token: string): DurableObjectStub {
  return env.MOTION_SESSION.get(env.MOTION_SESSION.idFromName(token));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  if (!body.ok) return body.response;

  const minted = await lobbyStub(env).fetch(internalRequest("/internal/mint", "POST", null, "{}"));
  if (minted.status !== 200) return minted;

  const payload = await minted.json<unknown>();
  if (!isRecord(payload) || !isTokenShaped(payload["token"])) {
    return json({ error: "unavailable" }, 503);
  }
  const token = payload["token"];
  // The session object is told its own token up front: that is what gives it
  // something to compare against, and what makes a fabricated token land on an
  // uninitialised object that answers 404.
  const initialised = await sessionStub(env, token).fetch(
    internalRequest("/internal/init", "POST", token, "{}"),
  );
  if (initialised.status !== 200) return json({ error: "unavailable" }, 503);
  return json(payload);
}

async function claimSession(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  if (!body.ok) return body.response;
  return await lobbyStub(env).fetch(internalRequest("/internal/claim", "POST", null, body.text));
}

async function forwardWithBody(
  request: Request,
  env: Env,
  token: string,
  path: string,
): Promise<Response> {
  const body = await readBody(request);
  if (!body.ok) return body.response;
  return await sessionStub(env, token).fetch(internalRequest(path, "POST", token, body.text));
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const seg = url.pathname.split("/").filter((s) => s.length > 0);

  // Same-origin only: no preflight is answered, ever.
  if (method === "OPTIONS") return methodNotAllowed("GET, POST");

  const first = seg[0];

  if (first === "api") {
    if (seg[1] === "session" && seg.length === 2) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await createSession(request, env);
    }
    if (seg[1] === "claim" && seg.length === 2) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await claimSession(request, env);
    }
    if (seg[1] === "end" && seg.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      const token = seg[2];
      if (!isTokenShaped(token)) return unknownSession();
      return await forwardWithBody(request, env, token, "/internal/end");
    }
    return notFound();
  }

  if (first === "ingest") {
    const token = seg[1];
    if (seg.length !== 2 || !isTokenShaped(token)) return unknownSession();
    if (method !== "POST") return methodNotAllowed("POST");
    return await forwardWithBody(request, env, token, "/internal/ingest");
  }

  if (first === "status") {
    const token = seg[1];
    if (seg.length !== 2 || !isTokenShaped(token)) return unknownSession();
    if (method !== "GET") return methodNotAllowed("GET");
    return await sessionStub(env, token).fetch(
      internalRequest("/internal/status", "GET", token, null),
    );
  }

  if (first === "mcp") {
    const token = seg[1];
    if (seg.length !== 2 || !isTokenShaped(token)) return unknownSession();
    // Stateless server: there is no server-initiated stream to open, so GET is
    // 405 rather than an SSE endpoint.
    if (method !== "POST") return methodNotAllowed("POST");
    return await forwardWithBody(request, env, token, "/internal/mcp");
  }

  // MCP connector setup (claude.ai included) probes /.well-known/oauth-* to
  // decide whether this server has a sign-in service. It does not — and the
  // SPA fallback answering 200 HTML here would claim otherwise, so the whole
  // namespace is a hard 404 for every method.
  if (first === ".well-known") return notFound();

  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  return await env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return harden(await route(request, env));
    } catch {
      // Nothing is logged anywhere in this project, and an exception must not
      // escape as an unhardened runtime error page carrying internals.
      return harden(json({ error: "internal error" }, 500));
    }
  },
};
