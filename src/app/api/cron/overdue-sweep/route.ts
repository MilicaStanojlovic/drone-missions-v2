import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runOverdueSweep } from "@/features/notifications/server/overdue-sweep";
import { logger } from "@/lib/logger";
import { withErrorHandling } from "@/lib/api/handler";

/**
 * `GET /api/cron/overdue-sweep` — the HTTP trigger for the nightly overdue
 * sweep, for deployments that have no long-lived process to hold a timer.
 *
 * ## Why this exists
 * In the containerised deployment this app was built for (`Dockerfile`,
 * `output: "standalone"`, `CMD ["node", "server.js"]`) the sweep is owned by
 * `src/lib/scheduler.ts`: `src/instrumentation.ts` runs once per server boot
 * and registers a node-cron timer for 09:00 Europe/Belgrade. That is the port
 * of Spring's `@Scheduled` `OverdueNotificationScheduler`, and on a container
 * it works exactly as the source does.
 *
 * On Vercel it cannot. There is no long-lived process: a lambda is frozen
 * seconds after it responds and reclaimed within minutes, so the odds that
 * some instance is both alive and thawed at 09:00 are ~nil — and
 * `scheduler.ts`'s `unref: true` (correct there, so a one-shot script can
 * still exit) guarantees the timer can never hold a process open anyway. The
 * sweep would silently never run: no overdue notifications, no emails, no
 * error. Worse, on the rare occasion it *did* fire it could fire on several
 * warm instances at once, and the sweep's dedupe is a read-then-write with no
 * transaction behind it (see below).
 *
 * So on Vercel the platform owns the schedule instead — `vercel.json`'s
 * `crons` entry calls this route — and `src/instrumentation.ts` skips
 * registering the in-process timer when `VERCEL` is set. The two mechanisms
 * are mutually exclusive by environment, never both at once.
 *
 * ## Why `/api/cron/…` and not `/api/v1/…`
 * `src/middleware.ts`'s matcher is `/api/v1/:path*`, which would try to verify
 * a user JWT and reject this request. Vercel Cron sends a platform bearer
 * token, not a user token, so the route has to sit outside that prefix.
 *
 * ## Idempotence
 * Safe to call more than once, and safe to retry. `runOverdueSweep` skips any
 * (pilot, mission) pair that already has a MISSION_OVERDUE notification
 * (`overdueExists` → `existsByUserMissionAndType`), so a second run is a
 * no-op and a run that times out part-way simply finishes its remaining
 * missions on the next one. `e2e/overdue.spec.ts` asserts exactly this:
 * sweep, badge = 1, sweep again, badge still 1.
 *
 * The one gap is genuinely *concurrent* runs — two callers can both pass the
 * existence check before either inserts, since nothing locks and there is no
 * unique index on `(user_id, mission_id, type)`. One scheduled call a day
 * makes that unlikely; closing it properly is a migration, not a route.
 */

/**
 * Vercel Hobby caps a function at 60s (the default is 10s). The sweep is a
 * deliberately sequential loop — an existence check, an insert, a user lookup
 * and an email per overdue mission — so a large backlog needs the headroom.
 * A run that still exceeds it is not lost: see the idempotence note above.
 */
export const maxDuration = 60;

/** Never prerender or cache a job trigger. */
export const dynamic = "force-dynamic";

/**
 * Constant-time compare of two secrets, so a caller cannot learn the token a
 * byte at a time from response timing. `timingSafeEqual` throws unless both
 * buffers are the same length, hence the length check first — that much is
 * unavoidably variable-time, but it leaks only the length.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const GET = withErrorHandling(async (request: Request) => {
  /**
   * Read straight from `process.env`, deliberately not through `@/lib/env`.
   *
   * This is the same call `src/instrumentation.ts` makes for `NEXT_RUNTIME`
   * and friends: a platform-owned variable is not part of the app's own
   * configuration schema. It also matters here for blast radius — `env.ts`
   * parses eagerly at import and is pulled into the Edge middleware bundle
   * (`middleware.ts` → `lib/auth/jwt` → `lib/env`), so a `.min(1)` entry
   * saved as an empty string in a hosting dashboard would throw inside
   * middleware and 500 *every* `/api/v1/*` request. A cron token is not
   * worth putting that at risk.
   */
  const expected = process.env.CRON_SECRET;

  // Fail closed. An unset secret means this endpoint is unconfigured, and it
  // notifies and emails every overdue pilot — never let that be reachable by
  // an anonymous GET just because a variable is missing.
  if (expected === undefined || expected === "") {
    logger.error("Overdue sweep trigger refused: CRON_SECRET is not set");
    return NextResponse.json({ message: "Cron trigger is not configured" }, { status: 401 });
  }

  // Vercel attaches this header automatically once CRON_SECRET exists.
  const provided = request.headers.get("authorization");
  if (provided === null || !secretMatches(provided, `Bearer ${expected}`)) {
    logger.warn("Overdue sweep trigger refused: bad or missing bearer token");
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  // Let a failure propagate to `withErrorHandling`'s 500 rather than
  // swallowing it the way `scheduler.ts`'s `runOverdueSweepSafely` does: a
  // cron platform can only see a run as failed if the response says so, and
  // the sweep is safe to retry.
  await runOverdueSweep();

  logger.info("Overdue sweep completed via cron trigger");
  return NextResponse.json({ status: "ok" }, { status: 200 });
});
