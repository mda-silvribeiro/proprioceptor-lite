// Shared Playwright fixtures: one static server per worker, contract-shaped API
// mocks per test, and a console watchdog that fails a test if the page logged an
// error. Because the fixture server sends the production CSP, that watchdog is
// also the regression test for "no inline script, no inline style".

import { test as base, expect } from "@playwright/test";
import { startStaticServer, type StaticServer } from "./server";
import { ApiMock } from "./api-mock";

export interface WorkerFixtures {
  origin: string;
}

export interface TestFixtures {
  /** Console/pageerror messages seen so far; asserted empty at teardown. */
  consoleErrors: string[];
  /** Installed before the first navigation — request it, then `page.goto`. */
  mock: ApiMock;
}

/**
 * The repo root, from the config file's own location — `config.rootDir` is the
 * resolved testDir, and the shell's working directory is nobody's business.
 */
function repoRoot(configFile: string | undefined, rootDir: string): string {
  if (configFile !== undefined && configFile !== "") {
    const cut = configFile.lastIndexOf("/");
    if (cut > 0) return configFile.slice(0, cut);
  }
  return `${rootDir}/../..`;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  origin: [
    async ({}, use, workerInfo) => {
      const root = repoRoot(workerInfo.config.configFile, workerInfo.config.rootDir);
      const server: StaticServer = await startStaticServer(`${root}/web/`);
      await use(server.origin);
      await server.stop();
    },
    { scope: "worker" },
  ],

  // Overriding the built-in option so `page.goto("/")` hits the fixture server.
  baseURL: async ({ origin }, use) => {
    await use(origin);
  },

  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // Several specs deliberately answer an API call with 404/429/abort, and the
      // browser logs a resource error for each. Those are the behaviour under
      // test, so they are filtered by URL — which leaves genuine asset 404s and
      // every CSP violation still failing the run.
      const url = message.location().url;
      if (/\/(api|ingest|status|mcp)\//.test(url)) return;
      errors.push(`${message.text()} @ ${url}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    await use(errors);
    expect(errors, "the page must log no errors (this also catches CSP violations)").toEqual([]);
  },

  mock: async ({ page, consoleErrors }, use) => {
    // Depending on consoleErrors guarantees the listeners are attached before the
    // first navigation without every spec having to name the fixture.
    void consoleErrors;
    const mock = new ApiMock();
    await mock.install(page);
    await use(mock);
  },
});

export { expect };
