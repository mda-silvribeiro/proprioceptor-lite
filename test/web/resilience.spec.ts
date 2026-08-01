// What the page does when the server pushes back: rate limits, a session that
// disappears mid-stream, a status endpoint that stops answering, and the
// deliberate ending of a session.

import { test, expect } from "./fixtures/harness";
import { MOCK_TOKEN } from "./fixtures/api-mock";
import { parseIngestBody } from "./fixtures/contract";
import { startSensorDriver, stopSensorDriver, stubPermissionGate } from "./fixtures/sensors";

async function beginStreaming(page: import("@playwright/test").Page): Promise<void> {
  await stubPermissionGate(page, "granted");
  await page.goto(`/s/${MOCK_TOKEN}`);
  await page.locator("#btn-sensors").click();
  await expect(page.locator("#live")).toBeVisible();
  await startSensorDriver(page, { mode: "relative", alpha: 45, beta: 10, gamma: 5 });
}

test("a 429 pauses uploads, counts down, keeps buffering, then recovers", async ({ page, mock }) => {
  mock.ingestOutcome = "429";
  mock.retryAfterS = 1;
  await beginStreaming(page);

  await expect(page.locator("#stream-chip")).toHaveText("paused", { timeout: 8000 });
  await expect(page.locator("#stream-msg")).toContainText("rate limit");
  await expect(page.locator("#stream-msg")).toContainText(/resuming in \d+ s/);
  // Nothing was accepted, so nothing is claimed as sent.
  await expect(page.locator("#v-sent")).toHaveText("0");

  // Sustained backpressure: the buffer hits its cap and drops the OLDEST frames.
  await expect.poll(async () => Number(await page.locator("#v-dropped").innerText()), {
    timeout: 15000,
  }).toBeGreaterThan(0);

  mock.ingestOutcome = "ok";
  await expect(page.locator("#stream-chip")).toHaveText("live", { timeout: 10000 });
  await stopSensorDriver(page);

  // Every batch respected the 25-frame ceiling, including the recovery burst.
  const sizes = mock.ingestBodies.map((body) => parseIngestBody(body).length);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(25);
  expect(Math.max(...sizes), "the backlog was still worth sending").toBeGreaterThan(5);
  await expect(page.locator("#v-sent")).not.toHaveText("0");
});

test("a network outage retries with backoff and says so", async ({ page, mock }) => {
  mock.ingestOutcome = "network";
  await beginStreaming(page);

  await expect(page.locator("#stream-chip")).toHaveText("retrying", { timeout: 8000 });
  await expect(page.locator("#stream-msg")).toContainText("Upload failed");
  await expect(page.locator("#stream-msg")).toContainText("still being buffered");

  mock.ingestOutcome = "ok";
  await expect(page.locator("#stream-chip")).toHaveText("live", { timeout: 15000 });
  await stopSensorDriver(page);
  await expect(page.locator("#v-sent")).not.toHaveText("0");
});

test("a session that vanishes mid-stream returns to the landing view", async ({ page, mock }) => {
  await beginStreaming(page);
  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);

  mock.ingestOutcome = "404";
  mock.statusOutcome = "404";
  await expect(page.locator("#view-landing")).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#banner-text")).toContainText("That session is gone");
  await expect(page.locator("#banner-text")).toContainText("Nothing was kept");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#view-phone")).toBeHidden();

  // Streaming really stopped: no further uploads once the session is gone.
  await stopSensorDriver(page);
  const sent = mock.ingestBodies.length;
  await page.waitForTimeout(1500);
  expect(mock.ingestBodies.length).toBe(sent);
  // And the next action is right there.
  await expect(page.locator("#btn-start")).toBeEnabled();
});

test("a status endpoint that stops answering shows stale, not fiction", async ({ page, mock }) => {
  mock.phoneIsStreaming(5, 0.2);
  await page.goto("/");
  await page.locator("#btn-start").click();
  await expect(page.locator("#d-chip")).toHaveText("live");

  mock.statusOutcome = "429";
  await expect(page.locator("#d-chip")).toHaveText("offline", { timeout: 8000 });
  await expect(page.locator("#d-phone")).toHaveText("last known — retrying");
  // The last known numbers stay on screen rather than being zeroed out.
  await expect(page.locator("#d-rate")).toHaveText("5.0 Hz");
  await expect(page.locator("#d-announce")).toContainText("Lost contact");

  mock.statusOutcome = "ok";
  await expect(page.locator("#d-chip")).toHaveText("live", { timeout: 15000 });
});

test("End & erase needs a confirmation, then erases and clears the UI", async ({ page, mock }) => {
  await page.goto("/");
  await page.locator("#btn-start").click();
  await expect(page.locator("#view-desktop")).toBeVisible();

  const block = page.locator("#end-desktop");
  await block.getByRole("button", { name: "End & erase" }).click();
  expect(mock.endPaths, "the first click only asks").toEqual([]);
  const confirm = block.getByRole("button", { name: "Yes, erase" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeFocused();

  // Cancel really cancels.
  await block.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(mock.endPaths).toEqual([]);

  await block.getByRole("button", { name: "End & erase" }).click();
  await block.getByRole("button", { name: "Yes, erase" }).click();

  await expect(page.locator("#view-landing")).toBeVisible();
  await expect(page.locator("#banner-text")).toContainText("Session ended and erased");
  expect(mock.endPaths).toEqual([`/api/end/${MOCK_TOKEN}`]);
  // Nothing about the dead session is left on screen.
  await expect(page.locator("#code-digits")).toHaveText("——————");
  await expect(page.locator("#connector-url")).toHaveText("—");
});

test("End & erase from the phone stops the stream too", async ({ page, mock }) => {
  await beginStreaming(page);
  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);

  const block = page.locator("#end-phone");
  await block.getByRole("button", { name: "End & erase" }).click();
  await block.getByRole("button", { name: "Yes, erase" }).click();

  await expect(page.locator("#view-landing")).toBeVisible();
  expect(mock.endPaths).toEqual([`/api/end/${MOCK_TOKEN}`]);

  await stopSensorDriver(page);
  const sent = mock.ingestBodies.length;
  await page.waitForTimeout(1500);
  expect(mock.ingestBodies.length).toBe(sent);
});

test("erasing something already gone is still a success", async ({ page, mock }) => {
  mock.endOutcome = "404";
  await page.goto("/");
  await page.locator("#btn-start").click();

  const block = page.locator("#end-desktop");
  await block.getByRole("button", { name: "End & erase" }).click();
  await block.getByRole("button", { name: "Yes, erase" }).click();

  await expect(page.locator("#banner-text")).toContainText("Session ended and erased");
  await expect(page.locator("#view-landing")).toBeVisible();
});

test("an erase that fails leaves the user somewhere they can retry", async ({ page, mock }) => {
  mock.endOutcome = "500";
  await page.goto("/");
  await page.locator("#btn-start").click();

  const block = page.locator("#end-desktop");
  await block.getByRole("button", { name: "End & erase" }).click();
  await block.getByRole("button", { name: "Yes, erase" }).click();

  await expect(block).toContainText("may still be live");
  await expect(block.getByRole("button", { name: "Yes, erase" })).toBeEnabled();
  await expect(page.locator("#view-desktop")).toBeVisible();

  mock.endOutcome = "ok";
  await block.getByRole("button", { name: "Yes, erase" }).click();
  await expect(page.locator("#view-landing")).toBeVisible();
});
