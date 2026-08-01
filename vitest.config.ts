import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/core/**/*.test.ts", "test/server/**/*.test.ts"],
    environment: "node",
  },
});
