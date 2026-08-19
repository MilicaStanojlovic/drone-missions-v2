import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";

/**
 * The app's env layer (`src/lib/env.ts`) requires `JWT_SECRET` unconditionally
 * (unlike `DATABASE_URL`/`FLYWAY_URL`, which stay optional so this DB-less
 * phase can boot). CI and fresh sandboxes have no `.env.local`, so the
 * webServer below is given a fixture value purely so `next dev` can start —
 * it is not a real credential and signs nothing that matters. `≥32` bytes to
 * satisfy the HS256 minimum-length rule ported from the Spring source.
 */
const E2E_JWT_SECRET = "e2e-playwright-fixture-secret-not-for-real-use-000000";

/**
 * Reads `.env.local`/`.env` the same way `vitest.config.ts` does (Vite's own
 * loader, third arg `""` because these vars aren't `VITE_`-prefixed), purely
 * so `e2e/auth.spec.ts` can read `process.env.DATABASE_URL` to decide
 * whether its live-DB suite should run — mirroring the `hasDb` convention in
 * `src/lib/audit.test.ts` / `src/app/api/v1/auth/routes.test.ts`.
 *
 * `next dev` (spawned below as `webServer`) already loads `.env.local` on
 * its own, in its own process, regardless of this — that's what lets the app
 * itself reach the DB. This config file is a *separate* Node process (the
 * Playwright CLI/test runner), which has no such auto-loading, so without
 * this it would never see `DATABASE_URL` and the live-DB spec would always
 * report "skipped" even with a real DB running. Assigning onto
 * `process.env` (rather than only reading `localEnv` locally) is what makes
 * it visible to `e2e/auth.spec.ts`'s own `process.env.DATABASE_URL` read —
 * test files run in worker processes forked from this one, inheriting its
 * environment at fork time.
 */
const localEnv = loadEnv("test", process.cwd(), "");
if (localEnv.DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = localEnv.DATABASE_URL;
}

/**
 * The port the app under test is served on. `next dev` binds `PORT` from the
 * environment or from `.env.local` (which it loads itself), so a checkout
 * that sets `PORT` — e.g. the Phase 4 worktree, which runs on `3001` so it
 * can sit alongside the main checkout on `3000` — would otherwise serve the
 * app on one port while Playwright waited on, and drove, another. Resolved
 * from the same two sources here, defaulting to Next's own default, and then
 * forwarded explicitly to the spawned server so both sides always agree.
 */
const PORT = process.env.PORT ?? localEnv.PORT ?? "3000";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: BASE_URL,
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
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // DATABASE_URL isn't listed here: per the `env` doc above, webServer
      // env is layered on top of `process.env`, not a replacement for it —
      // `next dev` already loads `.env.local` in its own process regardless
      // (that's how `pnpm dev` already reaches the DB locally today), and
      // the `process.env.DATABASE_URL` assignment above (from `.env.local`,
      // or a real CI secret) is inherited by this spawned process the same
      // way. Phase 0's foundation spec still boots and passes with no DB
      // configured (see e2e/health.spec.ts's `not_configured` case); Phase
      // 1's e2e/auth.spec.ts live-DB suite just skips itself when it's
      // unset, exactly like the Vitest live-DB suites do.
      JWT_SECRET: process.env.JWT_SECRET ?? E2E_JWT_SECRET,
      // Keeps the server's bind port and `BASE_URL` in lockstep even when
      // `PORT` came from `process.env` rather than the `.env.local` that
      // `next dev` reads on its own (see the `PORT` note above).
      PORT,
    },
  },
});
