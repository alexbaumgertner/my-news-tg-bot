import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // The database suites share one TEST_DATABASE_URL and reset its schemas.
    // Run test files one at a time so they cannot break each other.
    fileParallelism: false,
  },
});
