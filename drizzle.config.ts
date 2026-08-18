import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config.
 *
 * Used only for the two read-only, schema-owned-by-Flyway workflows
 * documented at the top of `src/db/schema.ts`:
 *
 * - `drizzle-kit pull`  — introspect a live, Flyway-migrated database and
 *   regenerate `src/db/schema.ts` from the real catalog. This is the
 *   canonical way to keep the hand-mirror honest once a database exists.
 * - `drizzle-kit generate`/`introspect` — driven by `pnpm db:check`
 *   (`scripts/check-schema-drift.mjs`), the real CI drift guard. Bare
 *   `drizzle-kit check` is deliberately NOT used for this: it only
 *   validates a migration-snapshot history against itself, never against a
 *   live database, and this project never runs `generate`/`migrate` for
 *   real, so that history never exists here. That script invokes
 *   `drizzle-kit` directly with its own `--dialect`/`--url` flags rather
 *   than `--config=drizzle.config.ts` (it needs two independent throwaway
 *   `--out` dirs per run, one per command, which this single config can't
 *   express) — see the script's header comment for the full mechanism.
 *
 * Drizzle never runs `migrate`/`push` in this project — Flyway owns all
 * DDL (see `db/migration/`, `flyway.conf`). `DATABASE_URL` is read directly
 * from `process.env` here (not through `src/lib/env.ts`'s Zod schema)
 * because drizzle-kit is a standalone CLI process, not part of the Next.js
 * app boot path, and both `pull` and `check` are no-ops without a real URL
 * regardless of how the value got validated.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
