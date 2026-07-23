import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 120_000, // go build + relay boot for the integration test
    fileParallelism: false,
    // In CI, also emit GitHub Actions annotations so a failing assertion or
    // unhandled error surfaces inline on the run (and in the public check API)
    // instead of being buried in the raw log.
    reporters: process.env.GITHUB_ACTIONS ? ["default", "github-actions"] : ["default"],
  },
});
