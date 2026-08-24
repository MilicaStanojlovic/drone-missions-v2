import "server-only";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * DB connection capability (replaces the Spring `HikariCP` datasource).
 *
 * A lazily-initialized, module-level `postgres.js` connection pool wrapped
 * in `drizzle(...)`, bound to `./schema.ts`.
 *
 * Lazy on purpose: `DATABASE_URL` is *optional* at parse time in this phase
 * (see `src/lib/env.ts`), so no database is configured yet. Nothing in this
 * module may open a socket at import time, or `next build` / `next dev` /
 * the Vitest suite would all try to dial a Postgres that doesn't exist.
 * A connection is only ever opened the first time `getDb()` is actually
 * called with `DATABASE_URL` set; calling it without one throws a clear,
 * immediate error instead of hanging on a connection attempt.
 *
 * Pool shape ports the behavioral intent of the Spring datasource block
 * (`application.properties` `spring.datasource.*`, HikariCP defaults) onto
 * `postgres.js`:
 * - `max: 10` — same ballpark as HikariCP's default `maximumPoolSize` (10).
 * - `prepare: true` (the `postgres.js` default) is what session-mode
 *   Supavisor requires — Supabase's *transaction*-mode pooler does not
 *   support prepared statements, but this app targets Supavisor session
 *   mode, which does, so prepared statements stay enabled rather than
 *   being turned off as they would for the transaction-mode pooler.
 *
 * Module-level singleton, guarded against Next.js dev-mode hot-reload
 * creating a fresh pool (and leaking connections) on every edit: the pool
 * and the bound `drizzle` instance are cached on `globalThis`, exactly like
 * the well-known Prisma/Next.js singleton pattern.
 */

type Database = PostgresJsDatabase<typeof schema>;

/**
 * The handle Drizzle hands a `db.transaction(async (tx) => …)` callback.
 *
 * Derived from `transaction()`'s own signature rather than imported from
 * `drizzle-orm/pg-core`, so it cannot drift from whatever this Drizzle
 * version actually passes in (the concrete `PgTransaction` type carries four
 * generic parameters that would have to be repeated — and kept correct — by
 * hand).
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Either the pool or an open transaction — what every query function that can
 * take part in a multi-statement flow accepts as its optional last argument.
 *
 * This is the port of what `@Transactional` does implicitly in Spring: there,
 * a repository call inside a transactional service method joins the ambient
 * transaction through a thread-bound `EntityManager`, so no call site mentions
 * it. Drizzle has no ambient transaction — the handle *is* the transaction —
 * so it has to be threaded explicitly. Both types share the same
 * `PgDatabase` query-builder surface, which is why a query module can run
 * unchanged against either.
 */
export type DbHandle = Database | Transaction;

/**
 * The handle a query should run on: the caller's transaction when it supplied
 * one, otherwise the process-wide pool (auto-commit, one statement per call —
 * exactly what a Spring repository call outside any transaction does).
 */
export function dbFor(tx?: DbHandle): DbHandle {
  return tx ?? getDb();
}

const globalForDb = globalThis as unknown as {
  __droneMissionsSql?: postgres.Sql;
  __droneMissionsDb?: Database;
};

function createDb(): Database {
  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL not configured — set it in .env.local (or the environment) before " +
        "running any code that touches the database. See .env.example.",
    );
  }

  const sql =
    globalForDb.__droneMissionsSql ??
    postgres(env.DATABASE_URL, {
      max: 10,
      prepare: true,
    });
  globalForDb.__droneMissionsSql = sql;

  return drizzle(sql, { schema });
}

/**
 * Returns the process-wide Drizzle database handle, creating the
 * underlying `postgres.js` pool on first call. Throws if `DATABASE_URL`
 * is not configured — call this only from code paths that actually need
 * to touch the database (e.g. `*.queries.ts` modules), never at module
 * top-level.
 */
export function getDb(): Database {
  if (!globalForDb.__droneMissionsDb) {
    globalForDb.__droneMissionsDb = createDb();
  }
  return globalForDb.__droneMissionsDb;
}

/**
 * Closes the underlying `postgres.js` pool and clears the cached singleton.
 * No Spring/Next.js runtime ever calls this (the pool lives for the life of
 * the process, same as HikariCP) — it exists only for live-DB Vitest suites
 * (e.g. `tests/lib/audit.test.ts`), which open a real connection and must
 * release it in an `afterAll` so the test process can exit instead of
 * hanging on an open socket. A no-op if no pool was ever created.
 */
export async function closeDb(): Promise<void> {
  if (globalForDb.__droneMissionsSql) {
    await globalForDb.__droneMissionsSql.end();
    globalForDb.__droneMissionsSql = undefined;
    globalForDb.__droneMissionsDb = undefined;
  }
}
