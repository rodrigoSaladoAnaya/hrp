import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/server/src/**/*.test.ts", "packages/cli/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
