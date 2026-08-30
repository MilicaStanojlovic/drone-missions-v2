import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { getDb } from "@/db/client";
import { logger } from "@/lib/logger";
import { withErrorHandling } from "@/lib/api/handler";

/**
 * `GET /api/health` — boot-level health probe.
 *
 * No Spring equivalent: the backend never wired up Actuator, so this route
 * is new rather than ported. It exists purely so the hosting platform (an
 * uptime monitor, load balancer, health probe) can confirm the Node process
 * is alive and, separately, whether it currently has a usable database
 * connection — without that second fact ever turning "the app is up" into
 * a 5xx.
 *
 * `status` is always `"ok"` at 200: reaching this handler at all already
 * proves the process booted (env parsed, modules loaded). `db` reports the
 * database's state as informational data, never as the HTTP status:
 * - `"not_configured"` — `DATABASE_URL` is unset in this environment (the
 *   expected state until Supabase is provisioned; see `src/lib/env.ts`).
 * - `"up"` — `SELECT 1` round-tripped through the pool in `src/db/client.ts`.
 * - `"down"` — `DATABASE_URL` is set but the query failed (pool exhausted,
 *   credentials wrong, DB unreachable); the failure is logged server-side
 *   via pino and never leaked into the response body.
 */

type DbHealth = "up" | "not_configured" | "down";

interface HealthResponseBody {
  status: "ok";
  db: DbHealth;
}

async function checkDb(): Promise<DbHealth> {
  if (!env.DATABASE_URL) {
    return "not_configured";
  }
  try {
    await getDb().execute(sql`select 1`);
    return "up";
  } catch (error) {
    logger.error({ err: error }, "Health check: database ping failed");
    return "down";
  }
}

export const GET = withErrorHandling(async () => {
  const db = await checkDb();
  return NextResponse.json<HealthResponseBody>({ status: "ok", db }, { status: 200 });
});
