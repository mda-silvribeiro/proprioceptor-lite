// Phone role, part two: the permission gate, the heading/pitch/roll mapping, and
// the shape of what actually goes on the wire.

import { test, expect } from "./fixtures/harness";
import { MOCK_TOKEN } from "./fixtures/api-mock";
import { allFrames, parseIngestBody } from "./fixtures/contract";
import {
  permissionCalls,
  startSensorDriver,
  stopSensorDriver,
  stubPermissionGate,
} from "./fixtures/sensors";

/** Open the phone view, grant permission, tap Start, and begin driving events. */
async function beginStreaming(
  page: import("@playwright/test").Page,
  config: Parameters<typeof startSensorDriver>[1],
): Promise<void> {
  await stubPermissionGate(page, "granted");
  await page.goto(`/s/${MOCK_TOKEN}`);
  await page.locator("#btn-sensors").click();
  await expect(page.locator("#live")).toBeVisible();
  await startSensorDriver(page, config);
}

test("the gate asks for orientation AND motion, separately, from the tap", async ({
  page,
  mock,
}) => {
  await stubPermissionGate(page, "granted");
  await page.goto(`/s/${MOCK_TOKEN}`);
  expect(await permissionCalls(page), "nothing is requested before the tap").toBe(0);

  await page.locator("#btn-sensors").click();
  await expect(page.locator("#live")).toBeVisible();
  await expect(page.locator("#gate")).toBeHidden();
  // iOS gates DeviceOrientationEvent and DeviceMotionEvent independently.
  expect(await permissionCalls(page)).toBe(2);
  expect(mock.ingestBodies, "no frames before a sensor reading exists").toEqual([]);
});

test("focus moves onto the live panel after Start, never stranded on <body>", async ({ page }) => {
  // Disabling the Start button drops focus to <body>; hiding the whole gate would
  // strand a keyboard/screen-reader user there. Focus must land on the live
  // heading that replaced it.
  await stubPermissionGate(page, "granted");
  await page.goto(`/s/${MOCK_TOKEN}`);
  await page.locator("#btn-sensors").click();
  await expect(page.locator("#live")).toBeVisible();
  await expect(page.locator("#live-h")).toBeFocused();
});

test("a denied grant explains the recovery path and offers a way out", async ({ page, mock }) => {
  await stubPermissionGate(page, "denied");
  await page.goto(`/s/${MOCK_TOKEN}`);
  await expect(page.locator("#gate-error")).toBeHidden();
  await expect(page.locator("#btn-gate-home")).toBeHidden();
  await page.locator("#btn-sensors").click();

  const error = page.locator("#gate-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("Settings → Safari → Motion & Orientation Access");
  await expect(page.locator("#live")).toBeHidden();
  await expect(page.locator("#btn-sensors")).toHaveText("Try again");
  await expect(page.locator("#btn-sensors")).toBeEnabled();
  // Focus lands on the retry action, not on <body> where disabling it left it.
  await expect(page.locator("#btn-sensors")).toBeFocused();
  await expect(page.locator("#btn-gate-home")).toBeVisible();
  expect(mock.ingestBodies).toEqual([]);

  // The way out actually leads somewhere.
  await page.locator("#btn-gate-home").click();
  await expect(page.locator("#view-landing")).toBeVisible();
});

test("a permission request that throws blames the gesture, not the user", async ({ page, mock }) => {
  void mock;
  await stubPermissionGate(page, "throw");
  await page.goto(`/s/${MOCK_TOKEN}`);
  await page.locator("#btn-sensors").click();

  await expect(page.locator("#gate-error")).toContainText("has to come from a tap");
  await expect(page.locator("#live")).toBeHidden();
});

test("relative orientation streams contract-valid frames at ~5 Hz", async ({ page, mock }) => {
  await beginStreaming(page, { mode: "relative", alpha: 90, beta: 20, gamma: -15 });

  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);
  await stopSensorDriver(page);

  const batch = parseIngestBody(mock.ingestBodies[0]);
  // One second of ~5 Hz sampling, with slack for scheduling.
  expect(batch.length).toBeGreaterThanOrEqual(2);
  expect(batch.length).toBeLessThanOrEqual(8);
  expect(mock.ingestPaths[0]).toBe(`/ingest/${MOCK_TOKEN}`);

  for (const frame of batch) {
    // heading = (360 - alpha + screenAngle) % 360 = 270 with alpha 90, angle 0
    expect(frame.headingDeg).toBeCloseTo(270, 6);
    expect(frame.headingAbsolute, "relative alpha is never sold as a compass").toBe(false);
    expect(frame.pitchDeg).toBeCloseTo(20, 6);
    expect(frame.rollDeg).toBeCloseTo(-15, 6);
    expect(frame.aMag).not.toBeNull();
  }

  // The frames are ordered and spaced like a 5 Hz stream.
  const deltas = batch.slice(1).map((frame, index) => frame.tMs - (batch[index]?.tMs ?? 0));
  for (const delta of deltas) {
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(700);
  }

  // And the UI shows the same numbers it sent.
  await expect(page.locator("#v-heading")).toHaveText("270°");
  await expect(page.locator("#l-heading")).toHaveText("heading (relative)");
  await expect(page.locator("#v-tilt")).toHaveText("+20° / −15°");
  await expect(page.locator("#v-absolute")).toHaveText("relative to start");
  await expect(page.locator("#needle")).toHaveAttribute("transform", "rotate(270.0 60 60)");
  await expect(page.locator("#compass")).toHaveAttribute(
    "aria-label",
    "Compass: heading 270 degrees, relative to where tracking started",
  );
  await expect(page.locator("#stream-chip")).toHaveText("live");
});

test("an absolute event is the only thing that sets headingAbsolute", async ({ page, mock }) => {
  await beginStreaming(page, { mode: "absolute", alpha: 30, beta: 0, gamma: 0 });

  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);
  await stopSensorDriver(page);

  for (const frame of allFrames(mock.ingestBodies)) {
    expect(frame.headingDeg).toBeCloseTo(330, 6); // (360 - 30) % 360
    expect(frame.headingAbsolute).toBe(true);
  }
  await expect(page.locator("#v-absolute")).toHaveText("compass (absolute)");
  await expect(page.locator("#l-heading")).toHaveText("heading (compass)");
});

test("iOS webkitCompassHeading is used verbatim, not derived from alpha", async ({ page, mock }) => {
  // alpha 90 would give 270 through the Android formula; Safari's own bearing
  // must win, and it must not be re-inverted or screen-angle corrected.
  await beginStreaming(page, { mode: "ios", alpha: 90, beta: 0, gamma: 0, compass: 200 });

  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);
  await stopSensorDriver(page);

  for (const frame of allFrames(mock.ingestBodies)) {
    expect(frame.headingDeg).toBeCloseTo(200, 6);
    expect(frame.headingAbsolute).toBe(true);
  }
  await expect(page.locator("#v-absolute")).toHaveText("compass (iOS)");
});

test("a rotated screen shifts the heading by screen.orientation.angle", async ({ page, mock }) => {
  // Landscape-primary: what the user calls forward is the device's +X edge, 90°
  // clockwise of the top edge, so the bearing gains the screen angle.
  await page.addInitScript(() => {
    Object.defineProperty(screen.orientation, "angle", { configurable: true, get: () => 90 });
  });
  await beginStreaming(page, { mode: "relative", alpha: 0, beta: 0, gamma: 0 });

  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);
  await stopSensorDriver(page);

  for (const frame of allFrames(mock.ingestBodies)) {
    expect(frame.headingDeg).toBeCloseTo(90, 6); // (360 - 0 + 90) % 360
  }
});

test("pitch folds past vertical and roll unfolds with it", async ({ page, mock }) => {
  // beta 170, gamma 10: the phone is past vertical, nearly face-down. Pitch folds
  // to 10 and roll takes the reflected branch, 170.
  await beginStreaming(page, { mode: "relative", alpha: 0, beta: 170, gamma: 10 });

  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);
  await stopSensorDriver(page);

  for (const frame of allFrames(mock.ingestBodies)) {
    expect(frame.pitchDeg).toBeCloseTo(10, 6);
    expect(frame.rollDeg).toBeCloseTo(170, 6);
  }
});

test("null angles travel as null — never as a fabricated zero", async ({ page, mock }) => {
  await beginStreaming(page, { mode: "nulls", accel: "none" });

  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);
  await stopSensorDriver(page);

  const frames = allFrames(mock.ingestBodies);
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.headingDeg, "a missing heading is null, not 0").toBeNull();
    expect(frame.pitchDeg).toBeNull();
    expect(frame.rollDeg).toBeNull();
    expect(frame.aMag).toBeNull();
    expect(frame.headingAbsolute).toBe(false);
    expect(frame.tMs).toBeGreaterThan(0);
  }

  // And the dials refuse to draw a value they do not have.
  await expect(page.locator("#v-heading")).toHaveText("—");
  await expect(page.locator("#v-tilt")).toHaveText("—");
  await expect(page.locator("#v-amag")).toHaveText("—");
  await expect(page.locator("#compass")).toHaveClass(/dial-nodata/);
  await expect(page.locator("#level")).toHaveClass(/dial-nodata/);
  await expect(page.locator("#compass")).toHaveAttribute("aria-label", "Compass: no heading yet");
});

test("a browser without orientation events says so and sends nothing", async ({ page, mock }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "DeviceOrientationEvent");
  });
  await page.goto(`/s/${MOCK_TOKEN}`);
  await page.locator("#btn-sensors").click();

  await expect(page.locator("#gate-error")).toContainText("Sensors are unavailable in this browser");
  await expect(page.locator("#btn-sensors")).toBeDisabled();
  await expect(page.locator("#btn-gate-home")).toBeVisible();
  expect(mock.ingestBodies).toEqual([]);
});

test("the streaming view fits a 320 px phone with reachable controls", async ({ page, mock }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await beginStreaming(page, { mode: "relative" });
  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);
  await stopSensorDriver(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, "no sideways scroll on the narrowest phone").toBeLessThanOrEqual(1);

  await expect(page.locator("#compass")).toBeVisible();
  await expect(page.locator("#level")).toBeVisible();

  // The destructive control stays pinned in thumb reach while the dials scroll.
  const endButton = page.locator("#end-phone").getByRole("button", { name: "End & erase" });
  await expect(endButton).toBeInViewport();
  const box = await endButton.boundingBox();
  expect(box?.height ?? 0, "touch target is at least 44 px tall").toBeGreaterThanOrEqual(44);

  // The wake-lock line is honest about what this browser actually did.
  await expect(page.locator("#wake-hint")).not.toHaveText(/Checking/);
  await expect(page.locator("#wake-hint")).toHaveText(/screen|auto-lock/);
});

test("a hidden page stops streaming and says why, then resumes", async ({ page, mock }) => {
  await beginStreaming(page, { mode: "relative" });
  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(0);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#stream-chip")).toHaveText("paused");
  await expect(page.locator("#stream-msg")).toContainText("foreground");

  const sent = mock.ingestBodies.length;
  await page.waitForTimeout(2500);
  expect(mock.ingestBodies.length, "a hidden page uploads nothing").toBe(sent);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => mock.ingestBodies.length, { timeout: 8000 }).toBeGreaterThan(sent);
  await stopSensorDriver(page);
  await expect(page.locator("#stream-chip")).toHaveText("live");
});
