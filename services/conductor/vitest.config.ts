import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 120_000, // go build + relay boot for the integration test
    fileParallelism: false,
  },
});
