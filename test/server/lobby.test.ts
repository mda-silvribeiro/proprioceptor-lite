import { describe, expect, it } from "vitest";
import {
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  LOBBY_MINT_LIMIT,
  LOBBY_MINT_WINDOW_MS,
  Lobby,
} from "../../src/do";
import { isCodeShaped, isTokenShaped } from "../../src/core/tokens";
import { MemoryStorage, TestClock, jsonOf } from "./shim";

interface Fixture {
  lobby: Lobby;
  clock: TestClock;
  storage: MemoryStorage;
  restart: () => void;
}

function fixture(): Fixture {
  const clock = new TestClock();
  const storage = new MemoryStorage();
  const state = { storage };
  const box: { lobby: Lobby } = { lobby: new Lobby(state, {}, { now: clock.now }) };
  return {
    get lobby() {
      return box.lobby;
    },
    clock,
    storage,
    restart: () => {
      box.lobby = new Lobby(state, {}, { now: clock.now });
    },
  };
}

function mintRequest(): Request {
  return new Request("https://lobby.internal/internal/mint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function claimRequest(body: unknown): Request {
  return new Request("https://lobby.internal/internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function mint(lobby: Lobby): Promise<{ token: string; code: string }> {
  const response = await lobby.fetch(mintRequest());
  expect(response.status).toBe(200);
  const body = await jsonOf(response);
  const token = body["token"];
  const code = body["code"];
  if (!isTokenShaped(token) || !isCodeShaped(code)) throw new Error("bad mint payload");
  return { token, code };
}

describe("Lobby — minting", () => {
  it("returns a token, a code, the MCP path and the code's lifetime", async () => {
    const { lobby } = fixture();
    const body = await jsonOf(await lobby.fetch(mintRequest()));
    expect(isTokenShaped(body["token"])).toBe(true);
    expect(isCodeShaped(body["code"])).toBe(true);
    expect(body["mcpPath"]).toBe(`/mcp/${String(body["token"])}`);
    expect(body["expiresInS"]).toBe(CODE_TTL_MS / 1000);
  });

  it("rate-limits new sessions globally with a Retry-After", async () => {
    const { lobby, clock } = fixture();
    for (let i = 0; i < LOBBY_MINT_LIMIT; i++) {
      expect((await lobby.fetch(mintRequest())).status).toBe(200);
      clock.advance(1000);
    }
    const limited = await lobby.fetch(mintRequest());
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(LOBBY_MINT_WINDOW_MS / 1000);

    // The window is rolling: once the oldest mint ages out, minting resumes.
    clock.advance(LOBBY_MINT_WINDOW_MS);
    expect((await lobby.fetch(mintRequest())).status).toBe(200);
  });

  it("rejects anything other than POST and unknown internal paths", async () => {
    const { lobby } = fixture();
    const wrongMethod = await lobby.fetch(
      new Request("https://lobby.internal/internal/mint", { method: "GET" }),
    );
    expect(wrongMethod.status).toBe(405);
    const wrongPath = await lobby.fetch(
      new Request("https://lobby.internal/internal/nope", { method: "POST", body: "{}" }),
    );
    expect(wrongPath.status).toBe(404);
  });
});

describe("Lobby — claiming", () => {
  it("trades a code for its token exactly once", async () => {
    const { lobby } = fixture();
    const { token, code } = await mint(lobby);

    const first = await lobby.fetch(claimRequest({ code }));
    expect(first.status).toBe(200);
    expect((await jsonOf(first))["token"]).toBe(token);

    const second = await lobby.fetch(claimRequest({ code }));
    expect(second.status).toBe(404);
    expect(await jsonOf(second)).toEqual({ error: "unknown session" });
  });

  it("expires a code after its TTL with the same uniform 404", async () => {
    const { lobby, clock } = fixture();
    const { code } = await mint(lobby);
    clock.advance(CODE_TTL_MS + 1);
    const response = await lobby.fetch(claimRequest({ code }));
    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "unknown session" });
  });

  it("survives an isolate restart mid-pairing", async () => {
    const f = fixture();
    const { token, code } = await mint(f.lobby);
    f.restart();
    const response = await f.lobby.fetch(claimRequest({ code }));
    expect(response.status).toBe(200);
    expect((await jsonOf(response))["token"]).toBe(token);
  });

  it("invalidates an outstanding code after 10 failed attempts", async () => {
    const { lobby } = fixture();
    const { code } = await mint(lobby);
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) {
      const wrong = String((Number(code) + i + 1) % 1_000_000).padStart(6, "0");
      expect((await lobby.fetch(claimRequest({ code: wrong }))).status).toBe(404);
    }
    // The real code is gone too — that is the brute-force bound.
    expect((await lobby.fetch(claimRequest({ code }))).status).toBe(404);
  });

  it("still honours a real code before the attempt budget is spent", async () => {
    const { lobby } = fixture();
    const { token, code } = await mint(lobby);
    for (let i = 0; i < CODE_MAX_ATTEMPTS - 1; i++) {
      const wrong = String((Number(code) + i + 1) % 1_000_000).padStart(6, "0");
      await lobby.fetch(claimRequest({ code: wrong }));
    }
    const response = await lobby.fetch(claimRequest({ code }));
    expect(response.status).toBe(200);
    expect((await jsonOf(response))["token"]).toBe(token);
  });

  it("does not let malformed codes burn the attempt budget", async () => {
    const { lobby } = fixture();
    const { token, code } = await mint(lobby);
    for (const bad of ["", "1", "abcdef", "12345", "1234567", null, 123456, {}, [], undefined]) {
      const response = await lobby.fetch(claimRequest({ code: bad }));
      expect(response.status).toBe(404);
    }
    const response = await lobby.fetch(claimRequest({ code }));
    expect(response.status).toBe(200);
    expect((await jsonOf(response))["token"]).toBe(token);
  });

  it("rejects a claim with no code, a broken body, or a wrong-typed body", async () => {
    const { lobby } = fixture();
    await mint(lobby);
    for (const body of ["", "{", "[]", '"code"', "null", '{"code":"000000","extra":1}']) {
      const response = await lobby.fetch(
        new Request("https://lobby.internal/internal/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(404);
    }
  });

  it("keeps codes distinct across many mints", async () => {
    const { lobby, clock } = fixture();
    const codes = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const { code } = await mint(lobby);
      codes.add(code);
      // Stay under the global mint limit by walking the clock forward.
      clock.advance(LOBBY_MINT_WINDOW_MS / 2);
    }
    expect(codes.size).toBe(30);
  });

  it("persists only its own book and nothing frame-shaped", async () => {
    const { lobby, storage } = fixture();
    await mint(lobby);
    expect(storage.keys()).toEqual(["book"]);
  });
});
