import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Reads `.env.local`/`.env` (Vite's own loader, the same files
 * `next dev`/`next build` read) so live-DB suites — `src/lib/audit.test.ts`
 * and the ones later phases add — can pick up a real `DATABASE_URL` when a
 * developer has one configured (e.g. `docker compose up db` +
 * `.env.local` per `MIGRATION_PLAN.md` §8) and fall back to their
 * "skipped — no DB configured" branch otherwise, exactly like
 * `GET /api/health` already does. Third arg `""` (no required prefix) is
 * needed because these vars aren't `VITE_`-prefixed — Vite's own default
 * safelist would otherwise filter them all out.
 *
 * Only `DATABASE_URL` is forwarded, not the whole of `.env.local`: every
 * other var (`JWT_EXPIRATION_MS`, `PORT`, `MAIL_ENABLED`, ...) stays exactly
 * the fixed value below/the schema default, so a developer's real
 * `.env.local` never perturbs `env.test.ts`'s default-value assertions.
 */
const localEnv = loadEnv("test", process.cwd(), "");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `server-only` is a marker package: its default `index.js` unconditionally
      // throws, and only becomes a no-op when a bundler resolves the `react-server`
      // export condition (which is what makes `import "server-only"` throw when a
      // Server Component's code is accidentally pulled into a client bundle, but a
      // no-op on the actual server). Next's webpack/Turbopack config recognizes that
      // condition; plain Vitest (Vite) does not, so every module under test that
      // starts with `import "server-only"` (errors.ts, logger.ts, handler.ts, ...)
      // would otherwise throw at import time regardless of environment. Since Vitest
      // always runs in a server-equivalent (Node) context here, aliasing straight to
      // the package's own no-op `empty.js` reproduces the same behavior Next's
      // bundler gives real server code.
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    env: {
      // Dummy, test-only value satisfying src/lib/env.ts's required
      // JWT_SECRET (>=32 bytes) so importing anything that pulls in the
      // `env` singleton doesn't fail the whole suite at module-load time.
      // Individual env.ts tests exercise fail-fast/rejection behavior via
      // loadEnv(fixture) directly, bypassing process.env entirely.
      JWT_SECRET: "vitest-test-only-jwt-secret-not-for-real-use",
      // Forwarded from .env.local/.env when present (see loadEnv() above);
      // undefined otherwise, matching src/lib/env.ts's "optional at parse
      // time" contract and reproducing the exact env this app already runs
      // under locally/in CI — no separate test-only connection string.
      // Spread-conditional: assigning `undefined` here would coerce to the
      // string "undefined" in process.env, making DB-less environments (CI
      // without a service) look like they HAVE a database and running every
      // live-DB suite against a bogus URL. Omit the key entirely instead.
      ...(localEnv.DATABASE_URL ? { DATABASE_URL: localEnv.DATABASE_URL } : {}),
    },
  },
});
