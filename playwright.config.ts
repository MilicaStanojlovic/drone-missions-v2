import { defineConfig, devices } from "@playwright/test";

/**
 * The app's env layer (`src/lib/env.ts`) requires `JWT_SECRET` unconditionally
 * (unlike `DATABASE_URL`/`FLYWAY_URL`, which stay optional so this DB-less
 * phase can boot). CI and fresh sandboxes have no `.env.local`, so the
 * webServer below is given a fixture value purely so `next dev` can start —
 * it is not a real credential and signs nothing that matters. `≥32` bytes to
 * satisfy the HS256 minimum-length rule ported from the Spring source.
 */
const E2E_JWT_SECRET = "e2e-playwright-fixture-secret-not-for-real-use-000000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // DATABASE_URL / FLYWAY_URL deliberately left unset: this phase's
      // happy path must boot and pass with no DB configured.
      JWT_SECRET: process.env.JWT_SECRET ?? E2E_JWT_SECRET,
    },
  },
});
