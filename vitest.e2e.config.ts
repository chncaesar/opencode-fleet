/**
 * vitest.e2e.config.ts
 *
 * Separate Vitest configuration for E2E tests that run against real OpenCode nodes.
 * Run with: npm run test:e2e
 *
 * Design decisions:
 * - 60s testTimeout: matches the SSE idle-wait ceiling for slow prompts
 * - 15s hookTimeout: enough for beforeEach/afterEach session cleanup
 * - singleFork sequential execution: prevents parallel SSE connections from
 *   interfering with each other on the same node
 * - verbose reporter: shows individual test names/timings for long-running E2E suites
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 15_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    reporter: "verbose",
    // Do NOT use the default vitest watch mode for E2E
    watch: false,
  },
});
