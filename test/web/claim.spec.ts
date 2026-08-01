// Phone role, part one: turning a 6-digit code into the /s/<token> view, and
// refusing to guess when the code is wrong.

import { test, expect } from "./fixtures/harness";
import { MOCK_CODE, MOCK_TOKEN } from "./fixtures/api-mock";

test("six digits auto-submit and land on the phone view", async ({ page, mock }) => {
  await page.goto("/");
  await page.locator("#code").fill(MOCK_CODE);

  await expect(page.locator("#view-phone")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/s/${MOCK_TOKEN}$`));
  await expect(page.locator("#btn-sensors")).toBeVisible();
  // Nothing streams before the tap.
  await expect(page.locator("#live")).toBeHidden();
  expect(mock.claimedCodes).toEqual([{ code: MOCK_CODE }]);
  await expect(page.locator("#phone-h")).toBeFocused();
});

test("non-digits are rejected at the input and only six digits submit", async ({ page, mock }) => {
  await page.goto("/");
  const input = page.locator("#code");
  await input.pressSequentially("4a8b1");
  await expect(input).toHaveValue("481");
  expect(mock.claimedCodes).toEqual([]);

  await input.pressSequentially("293");
  await expect(page.locator("#view-phone")).toBeVisible();
  expect(mock.claimedCodes).toEqual([{ code: MOCK_CODE }]);
});

test("a refused code gives one uniform message and stays put", async ({ page, mock }) => {
  mock.claimOutcome = "404";
  await page.goto("/");
  await page.locator("#code").fill("000000");

  await expect(page.locator("#claim-msg")).toContainText("That code didn't work");
  await expect(page.locator("#claim-msg")).toContainText("single-use");
  await expect(page.locator("#code")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#view-landing")).toBeVisible();
  await expect(page.locator("#view-phone")).toBeHidden();

  // The same message for an expired code — the server refuses to distinguish
  // them and neither does the page.
  const refused = await page.locator("#claim-msg").textContent();
  await page.locator("#code").fill("");
  await page.locator("#code").fill("999999");
  await expect(page.locator("#claim-msg")).toHaveText(refused ?? "");
});

test("a session link opens the phone view directly", async ({ page, mock }) => {
  await page.goto(`/s/${MOCK_TOKEN}`);

  await expect(page.locator("#view-phone")).toBeVisible();
  await expect(page.locator("#gate")).toBeVisible();
  await expect(page.locator("#view-landing")).toBeHidden();
  // Polling starts before streaming does, so the page can already report what
  // Claude is doing — and can discover that the session is gone.
  await expect.poll(() => mock.statusCalls).toBeGreaterThan(0);
});

test("a malformed session link goes home with the uniform message", async ({ page, mock }) => {
  void mock;
  await page.goto("/s/not-a-real-token");

  await expect(page.locator("#view-landing")).toBeVisible();
  await expect(page.locator("#banner")).toBeVisible();
  await expect(page.locator("#banner-text")).toContainText("That session is gone");
  await expect(page).toHaveURL(/\/$/);
});

test("a session that has already been erased sends the phone home", async ({ page, mock }) => {
  mock.statusOutcome = "404";
  await page.goto(`/s/${MOCK_TOKEN}`);

  await expect(page.locator("#view-landing")).toBeVisible();
  await expect(page.locator("#banner-text")).toContainText("That session is gone");
  await expect(page.locator("#btn-start")).toBeEnabled();
});
