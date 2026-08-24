import "server-only";
import { emailService } from "@/lib/email/email.service";
import { logger } from "@/lib/logger";
import { getMissionDao } from "@/features/missions/server/mission.cache";
import type { MissionStatus } from "@/features/missions/mission.types";
import { findByIdOrUndefined as findUserByIdOrUndefined } from "@/features/users/server/user.queries";
import { create as createNotification, overdueExists } from "@/features/notifications/server/notification.service";
import { NewNotification } from "@/features/notifications/notification.types";

/**
 * The overdue sweep — the port of
 * `business.service.notification.OverdueNotificationScheduler.notifyOverdueMissions()`.
 *
 * Nudges pilots about missions they won whose flight window has already
 * ended: one MISSION_OVERDUE notification plus the "has your flight ended?"
 * email per mission, ever, guarded by `overdueExists`.
 *
 * SOURCE: drone-missions-backend/.../business/service/notification/OverdueNotificationScheduler.java
 *
 * The job body lives here rather than in the scheduler module (`node-cron`
 * registration lands separately) for the same reason it is a plain method in
 * Java: it must be callable directly — by tests, and by any out-of-band
 * trigger — without a clock in the way.
 *
 * Deliberately raises **no audit entry**: the source scheduler audits nothing.
 * Its only effects are the notification, the email, and one summary log line.
 */

/**
 * Which statuses still owe a flight. Mirrors the source's
 * `ACTIVE_AWARDED = Set.of(AWARDED, IN_PROGRESS)` — a mission that is
 * COMPLETED needs no nudge, and one that is CANCELLED no longer wants one.
 */
const ACTIVE_AWARDED: readonly MissionStatus[] = ["AWARDED", "IN_PROGRESS"];

/**
 * The zone the sweep's day boundary is measured in. The source pins it twice
 * — once as the `@Scheduled(zone = …)` and once inside the method — and this
 * is the second of the two; the schedule itself is the scheduler module's
 * business.
 */
const ZONE = "Europe/Belgrade";

/**
 * Run one sweep.
 *
 * The cutoff is the **start of today** in `Europe/Belgrade`
 * (`LocalDate.now(zone).atStartOfDay(zone).toInstant()`), not "now": a
 * mission that ended at 07:00 this morning is given the rest of the day
 * before it is called overdue, so the 09:00 run never chases a flight that
 * has only just finished. `findOverdue` compares strictly (`end_time <
 * cutoff`), so a mission ending exactly at midnight is not yet overdue.
 *
 * Missions are read through `getMissionDao()` — the same contract every
 * mission read goes through — whose `findOverdue` is a documented cache
 * pass-through, so a sweep neither serves stale rows nor pollutes the cache
 * with a list nothing else reads.
 *
 * Sequential, not `Promise.all`, mirroring the source's `for` loop: the
 * dedupe guard is a read-then-write, and a mission that appeared twice in one
 * batch would otherwise be able to notify twice.
 *
 * Errors are **not** swallowed here — the source lets them propagate out of
 * the scheduled method too. Keeping one failed run from killing the process
 * belongs to the cron registration, which is where the source's Spring
 * scheduler handles it.
 */
export async function runOverdueSweep(): Promise<void> {
  const cutoff = startOfToday(ZONE);
  const overdue = await getMissionDao().findOverdue(ACTIVE_AWARDED, cutoff);

  let notified = 0;
  for (const mission of overdue) {
    // Non-null by `findOverdue`'s `awarded_pilot_id IS NOT NULL` predicate,
    // which the row type cannot express; the guard keeps the port honest
    // rather than asserting, and skipping is the same no-op the source's
    // `getAwardedPilotId()` would produce for a null pilot id.
    const pilotId = mission.awardedPilotId;
    if (pilotId === null) {
      continue;
    }
    if (await overdueExists(pilotId, mission.id)) {
      continue;
    }
    // `mission.name` is nullable in this schema while both the notification
    // copy and the mail port take a plain `string`; an unnamed mission
    // renders as an empty slot inside the quotes — the same substitution
    // `mission.service.ts` and `bid.service.ts` already make.
    const target = { id: mission.id, name: mission.name ?? "" };
    await createNotification(NewNotification.missionOverdue(pilotId, target));
    // The non-throwing lookup, mirroring the source's `.ifPresent`: a pilot
    // whose account has since gone gets the in-app notification and no
    // email, and the sweep carries on.
    const pilot = await findUserByIdOrUndefined(pilotId);
    if (pilot !== undefined) {
      await emailService.sendMissionOverdue(
        { email: pilot.email, username: pilot.username },
        { ...target, location: mission.location },
      );
    }
    notified++;
  }

  // Only when something happened, exactly as the source guards its `log.info`
  // — a daily job that found nothing must not add a line to the log every day.
  if (notified > 0) {
    logger.info(`Overdue sweep: notified ${notified} pilot(s) of finished-flight checks`);
  }
}

/**
 * The instant at which today began in `zone` — the port of
 * `LocalDate.now(zone).atStartOfDay(zone).toInstant()`.
 *
 * Written against `Intl` rather than pulling in a date library: this is the
 * only zone-aware arithmetic in the app, and the platform already carries the
 * IANA database that `java.time` was reading.
 *
 * Two steps, because JavaScript has no "wall-clock time in a named zone"
 * type. First read today's calendar date *as that zone sees it*, then find
 * the instant whose wall clock in that zone is that date at 00:00. The second
 * step is a fixed-point search: guess by pretending the wall clock is UTC,
 * measure the zone's offset at the guessed instant, correct, and re-measure
 * once. The re-measure matters exactly on the spring-forward and fall-back
 * days, when the offset at the guess differs from the offset at the answer.
 *
 * `atStartOfDay` resolves a midnight that a DST gap skipped to the first
 * instant after the gap; Belgrade shifts at 02:00, so no such midnight exists
 * there and the two agree on every day of the year.
 */
function startOfToday(zone: string, now: Date = new Date()): Date {
  const { year, month, day } = wallClock(zone, now);
  const asIfUtc = Date.UTC(year, month - 1, day);
  const guess = asIfUtc - offsetMs(zone, new Date(asIfUtc));
  return new Date(asIfUtc - offsetMs(zone, new Date(guess)));
}

/** The calendar/clock fields `zone` shows at `instant`. */
function wallClock(zone: string, instant: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

/** How far ahead of UTC `zone` is at `instant`, in milliseconds. */
function offsetMs(zone: string, instant: Date): number {
  const { year, month, day, hour, minute, second } = wallClock(zone, instant);
  // Whole seconds on both sides: the formatter has no millisecond field, so
  // the instant's own sub-second part must not leak into the difference.
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}
