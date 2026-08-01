// Contract-shaped mocks for every endpoint the page talks to. No Worker runs in
// these tests: the point is to pin the *page's* behaviour against the documented
// responses, including the unhappy ones (404 / 429 / dropped connection).
//
// Every knob is mutable so a test can flip a route mid-session — that is how the
// 429-backoff and session-gone paths are exercised.

import type { Page, Route } from "@playwright/test";

/** 22 base64url characters, as docs/CONTRACTS.md requires. */
export const MOCK_TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
export const MOCK_CODE = "481293";

export interface StatusBody {
  phone: { streaming: boolean; rateHz: number | null; lastFrameAgeS: number | null };
  mcp: { totalCalls: number; lastCallAgeS: number | null };
  session: { ageS: number; expiresInS: number };
}

export type Outcome = "ok" | "404" | "429" | "500" | "network";

const JSON_TYPE = "application/json; charset=utf-8";

export class ApiMock {
  token = MOCK_TOKEN;
  code = MOCK_CODE;
  expiresInS = 300;
  retryAfterS = 3;

  sessionOutcome: Outcome = "ok";
  claimOutcome: Outcome = "ok";
  ingestOutcome: Outcome = "ok";
  statusOutcome: Outcome = "ok";
  endOutcome: Outcome = "ok";

  status: StatusBody = {
    phone: { streaming: false, rateHz: null, lastFrameAgeS: null },
    mcp: { totalCalls: 0, lastCallAgeS: null },
    session: { ageS: 3, expiresInS: 3597 },
  };

  readonly ingestBodies: unknown[] = [];
  readonly ingestPaths: string[] = [];
  readonly claimedCodes: unknown[] = [];
  readonly endPaths: string[] = [];
  sessionCalls = 0;
  statusCalls = 0;

  async install(page: Page): Promise<void> {
    await page.route("**/api/session", async (route) => {
      this.sessionCalls += 1;
      if (await this.failIfNeeded(route, this.sessionOutcome)) return;
      await route.fulfill({
        status: 200,
        contentType: JSON_TYPE,
        body: JSON.stringify({
          token: this.token,
          code: this.code,
          mcpPath: `/mcp/${this.token}`,
          expiresInS: this.expiresInS,
        }),
      });
    });

    await page.route("**/api/claim", async (route) => {
      const body: unknown = route.request().postDataJSON();
      this.claimedCodes.push(body);
      if (await this.failIfNeeded(route, this.claimOutcome)) return;
      await route.fulfill({
        status: 200,
        contentType: JSON_TYPE,
        body: JSON.stringify({ token: this.token }),
      });
    });

    await page.route("**/ingest/*", async (route) => {
      const request = route.request();
      this.ingestPaths.push(new URL(request.url()).pathname);
      const body: unknown = request.postDataJSON();
      this.ingestBodies.push(body);
      if (await this.failIfNeeded(route, this.ingestOutcome)) return;
      const frames = (body as { frames?: unknown[] } | null)?.frames ?? [];
      await route.fulfill({
        status: 200,
        contentType: JSON_TYPE,
        body: JSON.stringify({ accepted: frames.length }),
      });
    });

    await page.route("**/status/*", async (route) => {
      this.statusCalls += 1;
      if (await this.failIfNeeded(route, this.statusOutcome)) return;
      await route.fulfill({ status: 200, contentType: JSON_TYPE, body: JSON.stringify(this.status) });
    });

    await page.route("**/api/end/*", async (route) => {
      this.endPaths.push(new URL(route.request().url()).pathname);
      if (await this.failIfNeeded(route, this.endOutcome)) return;
      await route.fulfill({
        status: 200,
        contentType: JSON_TYPE,
        body: JSON.stringify({ erased: true }),
      });
    });
  }

  /** @returns true when the request was already answered with a failure. */
  private async failIfNeeded(route: Route, outcome: Outcome): Promise<boolean> {
    if (outcome === "ok") return false;
    if (outcome === "network") {
      await route.abort("failed");
      return true;
    }
    if (outcome === "429") {
      await route.fulfill({
        status: 429,
        contentType: JSON_TYPE,
        headers: { "retry-after": String(this.retryAfterS) },
        body: JSON.stringify({ error: "rate limited" }),
      });
      return true;
    }
    if (outcome === "404") {
      // The contract's single uniform answer for an unknown token *or* a bad
      // pairing code.
      await route.fulfill({
        status: 404,
        contentType: JSON_TYPE,
        body: JSON.stringify({ error: "unknown session" }),
      });
      return true;
    }
    await route.fulfill({
      status: 500,
      contentType: JSON_TYPE,
      body: JSON.stringify({ error: "boom" }),
    });
    return true;
  }

  /** Convenience: the state the desktop sees once a phone is live. */
  phoneIsStreaming(rateHz = 4.8, lastFrameAgeS = 0.4): void {
    this.status = {
      ...this.status,
      phone: { streaming: true, rateHz, lastFrameAgeS },
    };
  }
}
