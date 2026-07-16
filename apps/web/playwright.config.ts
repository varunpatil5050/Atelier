import { defineConfig } from "@playwright/test";

/**
 * Multiplayer e2e harness (blueprint doc 13 §4): boots the real relay and the
 * web app, then drives multiple browser contexts into shared rooms.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // shared relay; rooms are unique per test but keep runs deterministic
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "go run atelier.dev/services/collab-relay/cmd/collab-relay",
      cwd: "../..",
      port: 8787,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      // Production build: dev-mode chunk compilation is slow and flaky under
      // multi-context load (six clients × unminified Monaco).
      command: "pnpm --filter @atelier/web build && pnpm --filter @atelier/web start",
      cwd: "../..",
      port: 3100,
      env: { PORT: "3100" },
      reuseExistingServer: true,
      timeout: 240_000,
    },
  ],
});
