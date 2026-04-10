import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Disable file logging during tests
    env: { LOG_TO_FILE: "0" },

    globals: true,

    // Colocated unit tests + separate integration/e2e directory
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],

    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/index.ts"],
    },
  },
});
