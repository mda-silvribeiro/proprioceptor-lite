import { describe, expect, it } from "vitest";
import worker, { MAX_BODY_BYTES } from "../../src/worker";
import { isCodeShaped, isTokenShaped, mintToken } from "../../src/core/tokens";
import { getReq, harness, jsonOf, postJson, type Harness } from "./shim";

const ORIGIN = "https://proprioceptor-lite.example";

function url(path: string): string {
  return `${ORIGIN}${path}`;
}

async function send(h: Harness, request: Request): Promise<Response> {
  return await worker.fetch(request, h.env);
}

async function startSession(h: Harness): Promise<{ token: string; code: string }> {
  const response = await send(h, postJson(url("/api/session"), {}));
  expect(response.status).toBe(200);
  const body = await jsonOf(response);
  const token = body["token"];
  const code = body["code"];
  if (!isTokenShaped(token) || !isCodeShaped(code)) throw new Error("bad session payload");
  return { token, code };
}

function frame(tMs: number): Record<string, unknown> {
  return {
    tMs,
    headingDeg: 123.4,
    pitchDeg: -12,
    rollDeg: 4.2,
    headingAbsolute: true,
    aMag: 10.1,
  };
}

describe("worker — the documented flow", () => {
  it("mints, claims, ingests, reports status, serves MCP and erases", async () => {
    const h = harness();
    const { token, code } = await startSession(h);

    const claimed = await jsonOf(await send(h, postJson(url("/api/claim"), { code })));
    expect(claimed["token"]).toBe(token);

    const ingested = await send(
      h,
      postJson(url(`/ingest/${token}`), { frames: [frame(1753795200000)] }),
    );
    expect(await jsonOf(ingested)).toEqual({ accepted: 1 });

    const status = await jsonOf(await send(h, getReq(url(`/status/${token}`))));
    expect(status["phone"]).toMatchObject({ streaming: true });
    expect(status["session"]).toMatchObject({ ageS: 0 });

    const mcpResponse = await send(
      h,
      postJson(url(`/mcp/${token}`), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "motion_get_orientation" },
      }),
    );
    const result = (await jsonOf(mcpResponse))["result"] as Record<string, unknown>;
    expect(result["structuredContent"]).toMatchObject({ freshSeconds: 0 });

    const ended = await send(h, postJson(url(`/api/end/${token}`), {}));
    expect(await jsonOf(ended)).toEqual({ erased: true });

    // Everything about the session is gone.
    expect((await send(h, getReq(url(`/status/${token}`)))).status).toBe(404);
  });

  it("returns the MCP path the connector should be pointed at", async () => {
    const h = harness();
    const body = await jsonOf(await send(h, postJson(url("/api/session"), {})));
    expect(body["mcpPath"]).toBe(`/mcp/${String(body["token"])}`);
    expect(body["expiresInS"]).toBe(300);
  });

  it("accepts POST /api/session with no body and no content type", async () => {
    const h = harness();
    const response = await send(h, new Request(url("/api/session"), { method: "POST" }));
    expect(response.status).toBe(200);
  });

  it("completes a full MCP handshake over HTTP", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const path = url(`/mcp/${token}`);

    const initialize = await jsonOf(
      await send(
        h,
        postJson(path, {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x" } },
        }),
      ),
    );
    expect((initialize["result"] as Record<string, unknown>)["protocolVersion"]).toBe("2025-06-18");

    const notified = await send(
      h,
      postJson(path, { jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notified.status).toBe(202);

    const listed = await jsonOf(
      await send(h, postJson(path, { jsonrpc: "2.0", id: 1, method: "tools/list" })),
    );
    const tools = (listed["result"] as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(3);
  });
});

describe("worker — uniform 404s", () => {
  it("treats a malformed token, an unknown token and a wiped session identically", async () => {
    const h = harness();
    const unknown = mintToken();
    const paths = [
      `/ingest/${unknown}`,
      `/status/${unknown}`,
      `/mcp/${unknown}`,
      `/api/end/${unknown}`,
      "/ingest/short",
      "/status/short",
      "/mcp/short",
      "/api/end/short",
      "/ingest/",
      "/status",
      "/mcp",
    ];
    for (const path of paths) {
      const request =
        path.startsWith("/status") ? getReq(url(path)) : postJson(url(path), { frames: [] });
      const response = await send(h, request);
      expect(response.status, path).toBe(404);
      expect(await jsonOf(response)).toEqual({ error: "unknown session" });
    }
  });

  it("returns a plain 404 for an unknown /api path", async () => {
    const h = harness();
    const response = await send(h, postJson(url("/api/nope"), {}));
    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "not found" });
  });

  it("answers OAuth discovery probes with 404, never the SPA page", async () => {
    const h = harness();
    const probes = [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp/whatever",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ];
    for (const path of probes) {
      const response = await send(h, getReq(url(path)));
      expect(response.status, path).toBe(404);
      expect(await jsonOf(response)).toEqual({ error: "not found" });
    }
    const posted = await send(h, postJson(url("/.well-known/register"), {}));
    expect(posted.status, "POST").toBe(404);
    // OPTIONS is the one exception: the global no-preflight 405 wins first.
    const preflight = await send(
      h,
      new Request(url("/.well-known/oauth-protected-resource"), { method: "OPTIONS" }),
    );
    expect(preflight.status, "OPTIONS").toBe(405);
    // None of it may fall through to the assets binding.
    expect(h.assetRequests).toHaveLength(0);
  });

  it("never reveals which stage failed for a bad pairing code", async () => {
    const h = harness();
    await startSession(h);
    const response = await send(h, postJson(url("/api/claim"), { code: "000000" }));
    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "unknown session" });
  });
});

describe("worker — methods", () => {
  it("answers OPTIONS with 405 rather than a CORS preflight", async () => {
    const h = harness();
    for (const path of ["/", "/api/session", `/mcp/${mintToken()}`]) {
      const response = await send(h, new Request(url(path), { method: "OPTIONS" }));
      expect(response.status).toBe(405);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
    }
  });

  it("answers GET /mcp/<token> with 405 (there is no server-initiated stream)", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const response = await send(h, getReq(url(`/mcp/${token}`)));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("rejects the wrong method on every API route", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const cases: [string, string][] = [
      ["/api/session", "GET"],
      ["/api/claim", "GET"],
      [`/api/end/${token}`, "GET"],
      [`/ingest/${token}`, "GET"],
      [`/status/${token}`, "POST"],
      [`/mcp/${token}`, "PUT"],
    ];
    for (const [path, method] of cases) {
      const response = await send(h, new Request(url(path), { method }));
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get("Allow")).not.toBeNull();
    }
  });

  it("passes GET and HEAD through to the assets binding and refuses the rest", async () => {
    const h = harness();
    expect((await send(h, getReq(url("/")))).status).toBe(200);
    expect((await send(h, new Request(url("/s/abc"), { method: "HEAD" }))).status).toBe(200);
    expect(h.assetRequests).toHaveLength(2);
    const refused = await send(h, new Request(url("/anything"), { method: "PUT" }));
    expect(refused.status).toBe(405);
    expect(h.assetRequests).toHaveLength(2);
  });
});

describe("worker — request hygiene", () => {
  it("refuses a declared body over the 32 KiB cap before reading it", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const response = await send(
      h,
      new Request(url(`/ingest/${token}`), {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);
  });

  it("refuses an oversized body even when Content-Length lies", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const response = await send(
      h,
      new Request(url(`/ingest/${token}`), {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "5" },
        body: "x".repeat(MAX_BODY_BYTES + 100),
      }),
    );
    expect(response.status).toBe(413);
  });

  it("refuses a nonsense Content-Length", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const response = await send(
      h,
      new Request(url(`/ingest/${token}`), {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "not-a-number" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("accepts a body just under the cap", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const frames = Array.from({ length: 25 }, (_v, i) => frame(1753795200000 + i * 200));
    const body = JSON.stringify({ frames });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(MAX_BODY_BYTES);
    const response = await send(
      h,
      new Request(url(`/ingest/${token}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(await jsonOf(response)).toEqual({ accepted: 25 });
  });

  it("requires application/json on a POST that carries a body", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const wrongType = await send(
      h,
      new Request(url(`/ingest/${token}`), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{"frames":[]}',
      }),
    );
    expect(wrongType.status).toBe(415);

    const noType = await send(
      h,
      new Request(url(`/ingest/${token}`), { method: "POST", body: '{"frames":[]}' }),
    );
    expect(noType.status).toBe(415);
  });

  it("tolerates a charset parameter on the content type", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const response = await send(
      h,
      new Request(url(`/ingest/${token}`), {
        method: "POST",
        headers: { "content-type": "Application/JSON; charset=UTF-8" },
        body: '{"frames":[]}',
      }),
    );
    expect(await jsonOf(response)).toEqual({ accepted: 0 });
  });

  it("passes a 422 from validation through unchanged", async () => {
    const h = harness();
    const { token } = await startSession(h);
    // Written as raw JSON: `1e999` only becomes Infinity on the server's parse,
    // and JSON.stringify would have flattened it to null on the way out.
    const body =
      '{"frames":[{"tMs":1,"headingDeg":0,"pitchDeg":0,"rollDeg":0,' +
      '"headingAbsolute":true,"aMag":1e999}]}';
    const response = await send(
      h,
      new Request(url(`/ingest/${token}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(422);
    expect(String((await jsonOf(response))["error"])).toContain("frames[0].aMag");
  });
});

describe("worker — response headers", () => {
  it("puts nosniff and no-referrer on every response", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const responses = [
      await send(h, getReq(url("/"))),
      await send(h, postJson(url("/api/session"), {})),
      await send(h, getReq(url(`/status/${token}`))),
      await send(h, getReq(url(`/mcp/${token}`))),
      await send(h, postJson(url("/api/nope"), {})),
      await send(h, new Request(url("/"), { method: "OPTIONS" })),
    ];
    for (const response of responses) {
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  it("puts the contract's exact CSP on HTML only", async () => {
    const h = harness();
    const html = await send(h, getReq(url("/")));
    expect(html.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
        "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );

    const jsonResponse = await send(h, postJson(url("/api/session"), {}));
    expect(jsonResponse.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("never sends CORS headers and never disables the motion sensors", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const responses = [
      await send(h, getReq(url("/"))),
      await send(h, postJson(url(`/mcp/${token}`), { jsonrpc: "2.0", id: 1, method: "ping" })),
      await send(h, new Request(url("/api/session"), { method: "OPTIONS" })),
    ];
    for (const response of responses) {
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(response.headers.get("Permissions-Policy")).toBeNull();
    }
  });

  it("hardens even a response produced by an unexpected failure", async () => {
    const h = harness();
    // A namespace that throws stands in for any runtime fault behind the router.
    const broken = {
      idFromName: () => {
        throw new Error("boom");
      },
    };
    const env = { ...h.env, LOBBY: broken } as unknown as typeof h.env;
    const response = await worker.fetch(postJson(url("/api/session"), {}), env);
    expect(response.status).toBe(500);
    expect(await jsonOf(response)).toEqual({ error: "internal error" });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("keeps Retry-After on a rate-limited response", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      expect((await send(h, postJson(url("/api/session"), {}))).status).toBe(200);
    }
    const limited = await send(h, postJson(url("/api/session"), {}));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("worker — token handling", () => {
  it("routes each token to its own session object", async () => {
    const h = harness();
    const a = await startSession(h);
    const b = await startSession(h);
    await send(h, postJson(url(`/ingest/${a.token}`), { frames: [frame(1753795200000)] }));

    const statusA = await jsonOf(await send(h, getReq(url(`/status/${a.token}`))));
    const statusB = await jsonOf(await send(h, getReq(url(`/status/${b.token}`))));
    expect((statusA["phone"] as { streaming: boolean }).streaming).toBe(true);
    expect((statusB["phone"] as { streaming: boolean }).streaming).toBe(false);
  });

  it("tolerates a trailing slash on a token path", async () => {
    const h = harness();
    const { token } = await startSession(h);
    expect((await send(h, getReq(url(`/status/${token}/`)))).status).toBe(200);
  });

  it("does not accept a token with an extra path segment", async () => {
    const h = harness();
    const { token } = await startSession(h);
    const response = await send(h, getReq(url(`/status/${token}/extra`)));
    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "unknown session" });
  });
});
