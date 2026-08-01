import { defineConfig } from "@playwright/test";

// CHROMIUM_PATH lets a sandbox with a pre-installed browser point at it
// (e.g. /opt/pw-browsers/chromium); CI installs browsers normally and
// leaves it unset.
export default defineConfig({
  testDir: "test/web",
  timeout: 30_000,
  use: {
    launchOptions: process.env["CHROMIUM_PATH"]
      ? { executablePath: process.env["CHROMIUM_PATH"] }
      : {},
  },
});
