// Desktop role: create a session, show the connector URL and pairing code, copy
// the URL, and degrade honestly when /api/session refuses.

import { test, expect } from "./fixtures/harness";
import { MOCK_CODE, MOCK_TOKEN } from "./fixtures/api-mock";
import {
  copiedText,
  execCopies,
  stubClipboard,
  stubClipboardUnavailable,
} from "./fixtures/sensors";

test("landing offers both roles and starts hidden of everything else", async ({ page, mock }) => {
  void mock;
  await page.goto("/");

  await expect(page.locator("#view-landing")).toBeVisible();
  await expect(page.locator("#view-desktop")).toBeHidden();
  await expect(page.locator("#view-phone")).toBeHidden();
  await expect(page.locator("#btn-start")).toBeVisible();
  await expect(page.locator("#code")).toBeVisible();
  // Empty state: placeholders are dashes, never zeros.
  await expect(page.locator("#connector-url")).toHaveText("—");
  await expect(page.locator("#d-rate")).toHaveText("—");
});

test("creating a session shows the connector URL, the code and a countdown", async ({
  page,
  mock,
}) => {
  await page.goto("/");
  await page.locator("#btn-start").click();

  await expect(page.locator("#view-desktop")).toBeVisible();
  await expect(page.locator("#code-digits")).toHaveText(MOCK_CODE);
  await expect(page.locator("#code-digits")).toHaveAttribute(
    "aria-label",
    "Pairing code 4 8 1 2 9 3",
  );
  await expect(page.locator("#connector-url")).toHaveText(
    `${new URL(page.url()).origin}/mcp/${MOCK_TOKEN}`,
  );
  await expect(page.locator("#code-countdown")).toHaveText(/^[45]:\d\d$/);
  expect(mock.sessionCalls).toBe(1);

  // First poll answers "paired but quiet"; then the phone starts and the same
  // panel flips to live, announcing it exactly once.
  await expect(page.locator("#d-chip")).toHaveText("quiet");
  await expect(page.locator("#d-phone")).toHaveText("paired but quiet");
  mock.phoneIsStreaming(4.8, 0.4);
  await expect(page.locator("#d-chip")).toHaveText("live");
  await expect(page.locator("#d-rate")).toHaveText("4.8 Hz");
  await expect(page.locator("#d-fresh")).toHaveText("0.4 s ago");
  await expect(page.locator("#d-announce")).toHaveText(
    "Phone connected, streaming at 4.8 Hz.",
  );

  mock.status = { ...mock.status, mcp: { totalCalls: 12, lastCallAgeS: 12.1 } };
  await expect(page.locator("#d-mcp")).toHaveText("12 calls, last 12 s ago");

  // Focus moved to the new view's heading, so a keyboard user is not stranded.
  await expect(page.locator("#desktop-h")).toBeFocused();
});

test("the whole desktop flow is keyboard operable", async ({ page, mock }) => {
  await stubClipboard(page);
  await page.goto("/");

  await page.locator("#btn-start").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#view-desktop")).toBeVisible();

  // Tab to the copy button and activate it with the keyboard alone.
  const copy = page.locator("#btn-copy");
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#btn-copy-label")).toHaveText("Copied");
  expect(await copiedText(page)).toEqual([`${new URL(page.url()).origin}/mcp/${mock.token}`]);
});

test("copy falls back to the textarea path when the clipboard API is absent", async ({
  page,
  mock,
}) => {
  void mock;
  await stubClipboardUnavailable(page);
  await page.goto("/");
  await page.locator("#btn-start").click();
  await page.locator("#btn-copy").click();

  await expect(page.locator("#btn-copy-label")).toHaveText("Copied");
  expect(await execCopies(page)).toEqual([`${new URL(page.url()).origin}/mcp/${MOCK_TOKEN}`]);
  // The shim must not linger in the document.
  await expect(page.locator("textarea.copy-shim")).toHaveCount(0);
});

test("a rate-limited session create surfaces the wait, then re-enables", async ({ page, mock }) => {
  mock.sessionOutcome = "429";
  mock.retryAfterS = 2;
  await page.goto("/");
  await page.locator("#btn-start").click();

  await expect(page.locator("#start-msg")).toContainText("resuming in 2 s");
  await expect(page.locator("#btn-start")).toBeDisabled();
  await expect(page.locator("#view-landing")).toBeVisible();

  mock.sessionOutcome = "ok";
  await expect(page.locator("#btn-start")).toBeEnabled({ timeout: 6000 });
  await page.locator("#btn-start").click();
  await expect(page.locator("#view-desktop")).toBeVisible();
});

test("an unreachable server says so instead of leaking an exception", async ({ page, mock }) => {
  mock.sessionOutcome = "network";
  await page.goto("/");
  await page.locator("#btn-start").click();

  await expect(page.locator("#start-msg")).toHaveText("Couldn't reach the server.");
  await expect(page.locator("#btn-start")).toBeEnabled();
});

test.describe("presentation", () => {
  test("no horizontal overflow at 320 px or 1440 px", async ({ page, mock }) => {
    void mock;
    for (const size of [
      { width: 320, height: 640 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await page.goto("/");
      await page.locator("#btn-start").click();
      await expect(page.locator("#view-desktop")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `no sideways scroll at ${size.width} px`).toBeLessThanOrEqual(1);
    }
  });

  test("both colour schemes are authored", async ({ page, mock }) => {
    void mock;
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    expect(light).toBe("rgb(251, 251, 252)");
    expect(dark).toBe("rgb(14, 17, 22)");
  });

  test("reduced motion makes the dials snap", async ({ page, mock }) => {
    void mock;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const duration = await page.evaluate(() => {
      const needle = document.querySelector("#needle");
      return needle === null ? "" : getComputedStyle(needle).transitionDuration;
    });
    expect(parseFloat(duration), "needle transition is effectively instant").toBeLessThan(0.05);

    await page.emulateMedia({ reducedMotion: "no-preference" });
    const eased = await page.evaluate(() => {
      const needle = document.querySelector("#needle");
      return needle === null ? "" : getComputedStyle(needle).transitionDuration;
    });
    expect(parseFloat(eased)).toBeGreaterThan(0);
  });
});
