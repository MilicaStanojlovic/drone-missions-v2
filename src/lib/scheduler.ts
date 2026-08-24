import "server-only";
import { schedule, type ScheduledTask } from "node-cron";
import { runOverdueSweep } from "@/features/notifications/server/overdue-sweep";
import { logger } from "@/lib/logger";

/**
 * The app's scheduled jobs — the port of Spring's `@EnableScheduling`
 * (`DroneMissionsApplication`) plus the one `@Scheduled` method the app
 * actually owns, `OverdueNotificationScheduler.notifyOverdueMissions()`.
 *
 * Spring discovers scheduled work by scanning for the annotation, so the
 * schedule lives next to the job body. `node-cron` has no scanner: something
 * has to call `cron.schedule(...)` at startup, and that "something" is this
 * module, called from `src/instrumentation.ts`. The split keeps the sweep
 * itself (`features/notifications/overdue-sweep.ts`) a plain async function
 * that tests and any out-of-band trigger can call with no clock in the way —
 * exactly what `notifyOverdueMissions()` is in Java once the proxy is off it.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/notification/OverdueNotificationScheduler.java (line 39)
 * - drone-missions-backend/.../DroneMissionsApplication.java (`@EnableScheduling`)
 */

/**
 * The overdue sweep's schedule, translated field-for-field from the source's
 * `@Scheduled(cron = "0 0 9 * * *")`.
 *
 * Spring's cron is six fields, seconds-first (`sec min hour dom mon dow`);
 * node-cron's canonical form is the five-field Unix one, with the seconds
 * field optional. Dropping the leading `0` yields `0 9 * * *` — 09:00 every
 * day — which is the same set of instants, and is written in the five-field
 * form because that is what a reader of a cron string expects by default.
 */
export const OVERDUE_SWEEP_CRON = "0 9 * * *";

/**
 * The zone the 09:00 is read in, from the source's `@Scheduled(zone = …)`.
 *
 * Not a cosmetic detail and not derivable from the server's own clock: the
 * host runs in UTC, so without this the sweep would fire at 09:00 UTC — 10:00
 * or 11:00 Belgrade depending on the season, and, worse, on a *different* side
 * of the day boundary than the cutoff the job computes for itself (see
 * `startOfToday` in `overdue-sweep.ts`, which pins the same zone
 * independently, just as the source pins it twice).
 */
export const OVERDUE_SWEEP_ZONE = "Europe/Belgrade";

/** The task's node-cron name — what identifies it in `cron.getTasks()`. */
const OVERDUE_SWEEP_NAME = "overdue-sweep";

/**
 * The registered task, parked on `globalThis` rather than in a module-local
 * `let` for the same reason the DB pool and the mission DAO are
 * (`db/client.ts`, `mission.cache.ts`): Next's dev server re-evaluates module
 * graphs on hot reload, and a module-local guard resets with the module. The
 * guard has to outlive the module or every edit would leave another 09:00
 * timer behind, and the sweep would eventually run N times a day — each run
 * duplicating nothing (`overdueExists` still dedupes) but each one hammering
 * the database for a list only the first run can act on.
 */
const globalForScheduler = globalThis as unknown as {
  __droneMissionsScheduler?: ScheduledTask;
};

/**
 * Register the app's scheduled jobs. Idempotent: a second call while a task is
 * already registered is a no-op, so `instrumentation.ts` running twice (dev
 * hot reload, or a runtime that calls `register()` per worker boot) can never
 * double-schedule.
 *
 * Returns the task so a caller — a test, mainly — can inspect it; production
 * callers ignore it.
 */
export function startScheduler(): ScheduledTask {
  const existing = globalForScheduler.__droneMissionsScheduler;
  if (existing) {
    return existing;
  }

  const task = schedule(OVERDUE_SWEEP_CRON, runOverdueSweepSafely, {
    timezone: OVERDUE_SWEEP_ZONE,
    name: OVERDUE_SWEEP_NAME,
    // A cron timer must not be the reason the process stays alive: the server
    // is kept up by its own listener, and a one-off script that imports this
    // module should still be able to exit.
    unref: true,
  });
  globalForScheduler.__droneMissionsScheduler = task;

  logger.info(
    { cron: OVERDUE_SWEEP_CRON, timezone: OVERDUE_SWEEP_ZONE },
    "Scheduler started: overdue sweep registered",
  );
  return task;
}

/**
 * Stop and forget the registered jobs, so a later `startScheduler()` registers
 * fresh ones.
 *
 * Nothing in the running app calls this — Spring's scheduler likewise lives
 * for the life of the context. It exists for tests, which must not leave a
 * live timer behind for the next file to trip over. A no-op if nothing was
 * ever started.
 */
export function stopScheduler(): void {
  const task = globalForScheduler.__droneMissionsScheduler;
  if (!task) {
    return;
  }
  globalForScheduler.__droneMissionsScheduler = undefined;
  // `destroy()` both stops the timer and drops the task from node-cron's
  // registry; `stop()` alone would leave it discoverable and restartable.
  void task.destroy();
}

/**
 * The scheduled callback: one sweep, with anything it throws logged and
 * swallowed.
 *
 * This is the one place the port deliberately adds behavior the source does
 * not spell out, because the runtimes differ. Spring's `ScheduledExecutor`
 * catches whatever a `@Scheduled` method throws, logs it, and keeps the
 * trigger alive for the next fire. In Node an async callback that rejects with
 * nobody watching is an unhandled rejection — fatal by default since Node 15,
 * which would take the whole server down because one nightly query failed.
 * Catching here reproduces Spring's actual behavior rather than diverging from
 * it.
 *
 * The sweep is left to throw on its own (see its docblock): callers that want
 * a failure — the live test, an out-of-band trigger — get one; only this
 * unattended timer converts it into a log line.
 */
async function runOverdueSweepSafely(): Promise<void> {
  try {
    await runOverdueSweep();
  } catch (error) {
    logger.error({ err: error }, "Overdue sweep failed");
  }
}
