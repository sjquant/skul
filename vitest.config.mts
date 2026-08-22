import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    env: { NO_COLOR: "1" },
    // The CLI suites drive real git subprocesses and temporary worktrees. Several
    // take seconds on their own, so the 5s default times out once enough files
    // run in parallel — generous here, while a genuine hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      include: ["src/**/*.ts"],
    },
  },
});
