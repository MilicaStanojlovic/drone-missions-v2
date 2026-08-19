import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { Mission, MissionStatus } from "@/features/missions/mission.types";

/**
 * Live-DB proof of the overdue sweep's **done-when**: a seeded overdue awarded
 * mission yields exactly one notification and exactly one email across two
 * sweep runs, and a mission whose flight window has not closed yet is left
 * alone.
 *
 * `overdue-sweep.test.ts` already covers every branch of the job, but it stubs
 * the DAO, the notification service and the mail port, so the two things this
 * phase actually promises stay unproven there:
 *
 *  - **the dedupe is real.** The unit suite's second-run case relies on a
 *    hand-written `Set` standing in for `overdueExists`; whether the *database*
 *    remembers — `existsByUser_IdAndMission_IdAndType` over the row the first
 *    run committed — can only be shown against a real `notification` table.
 *  - **the cutoff really selects.** The unit suite asserts which `Date` is
 *    handed to `findOverdue`; that the SQL then admits a past-`end_time`
 *    mission and rejects a future one is a property of the query, here run
 *    unmocked against Postgres.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`, the same
 * shape as `mission.service.live.test.ts` and `bid.service.live.test.ts`.
 *
 * ## Why `findOverdue`'s result is narrowed to this run's rows
 * The sweep is by nature database-wide: it notifies *every* pilot holding an
 * overdue mission, so against a shared dev database it would also fire on rows
 * another suite seeded (`mission.queries.test.ts` seeds overdue missions of its
 * own) and then tear down underneath it. The query below is therefore run
 * unmodified and its result filtered to the two missions this file seeded.
 *
 * That narrowing cannot mask the behaviour under test, because **both** seeded
 * missions are in the allowed set: whether the future-`end_time` one is swept
 * is still decided entirely by the real SQL predicate, and if the query wrongly
 * returned it the filter would let it straight through to the assertions below.
 *
 * SOURCE (the behaviour under test, not a test to mirror — the backend ships no
 * `OverdueNotificationSchedulerTest`):
 * - drone-missions-backend/.../business/service/notification/OverdueNotificationScheduler.java
 */

/**
 * The mission ids this file seeded. Hoisted (`vi.hoisted`) because `vi.mock`'s
 * factory is lifted above the imports and would otherwise read this binding
 * before it exists; populated in `beforeAll`, which runs long after both.
 */
const scope = vi.hoisted(() => ({ missionIds: new Set<number>() }));

vi.mock("@/features/missions/mission.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/missions/mission.queries")>();
  return {
    ...actual,
    findOverdue: async (statuses: readonly MissionStatus[], endedBefore: Date) => {
      const rows = await actual.findOverdue(statuses, endedBefore);
      return rows.filter((row: Mission) => scope.missionIds.has(row.id));
    },
  };
});

// `vi.mock` above is hoisted by Vitest, so these static imports already resolve
// against the wrapped query module — including `mission.cache.ts`, whose
// uncached DAO is built out of `mission.queries`' exports, which is the route
// `runOverdueSweep` takes to the database.
import { closeDb, getDb } from "@/db/client";
import { mission, notification, users } from "@/db/schema";
import { emailService } from "@/lib/email/email.service";
import { logger } from "@/lib/logger";
import { runOverdueSweep } from "./overdue-sweep";

const hasDb = Boolean(process.env.DATABASE_URL);

/** A day, in milliseconds — the seeds' distance from "now". */
const DAY_MS = 24 * 60 * 60 * 1000;

describe.runIf(hasDb)("overdue-sweep.ts (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();

  const insertedUserIds: number[] = [];
  const insertedMissionIds: number[] = [];

  let designerId: number;
  let pilotId: number;
  let pilotEmail: string;
  /** AWARDED, its flight window closed days ago: the sweep's target. */
  let overdueMissionId: number;
  /** AWARDED to the same pilot, but still days from ending: must be left alone. */
  let futureMissionId: number;

  let sendMissionOverdueSpy: MockInstance<typeof emailService.sendMissionOverdue>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  async function insertUser(label: string, role: "DESIGNER" | "PILOT"): Promise<number> {
    const now = new Date();
    const email = `overdue-sweep-${runId}-${label}@example.com`;
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `overdue-sweep-${label}`,
        email,
        // A literal, obviously-not-a-hash placeholder: nothing here
        // authenticates, and the column is only NOT NULL.
        passwordHash: "not-a-real-hash",
        role,
        suspended: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id });
    insertedUserIds.push(row.id);
    if (role === "PILOT") {
      pilotEmail = email;
    }
    return row.id;
  }

  /**
   * Inserts an AWARDED mission directly rather than through `save()`, so
   * `end_time` — the only column either case turns on — is pinned exactly.
   */
  async function insertAwardedMission(name: string, endTime: Date): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(mission)
      .values({
        name,
        description: `Overdue-sweep fixture ${runId}`,
        status: "AWARDED",
        moderation: "VISIBLE",
        userId: designerId,
        awardedPilotId: pilotId,
        location: "Novi Sad",
        startTime: new Date(endTime.getTime() - DAY_MS),
        endTime,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: mission.id });
    insertedMissionIds.push(row.id);
    scope.missionIds.add(row.id);
    return row.id;
  }

  /** Every MISSION_OVERDUE notification raised for this pilot about `missionId`. */
  async function overdueNotifications(missionId: number) {
    return getDb()
      .select()
      .from(notification)
      .where(
        and(
          eq(notification.userId, pilotId),
          eq(notification.missionId, missionId),
          eq(notification.type, "MISSION_OVERDUE"),
        ),
      );
  }

  /**
   * The overdue emails sent about `missionId`. Filtered rather than counted
   * outright for the same reason the query result is narrowed: a shared
   * database can hold other pilots' overdue missions.
   */
  function overdueEmails(missionId: number) {
    return sendMissionOverdueSpy.mock.calls.filter(([, target]) => target.id === missionId);
  }

  beforeAll(async () => {
    designerId = await insertUser("designer", "DESIGNER");
    pilotId = await insertUser("pilot", "PILOT");
    // Two days past: comfortably before the start of today in Europe/Belgrade,
    // whatever offset the zone happens to be on, so the case never depends on
    // the hour the suite runs at.
    overdueMissionId = await insertAwardedMission(
      `Overdue ${runId}`,
      new Date(Date.now() - 2 * DAY_MS),
    );
    futureMissionId = await insertAwardedMission(
      `Still flying ${runId}`,
      new Date(Date.now() + 2 * DAY_MS),
    );
    // Left calling through: with `MAIL_ENABLED` false (the test default) the
    // real port renders the template and logs what it would have sent, so the
    // spy counts sends without replacing the pipeline it is counting.
    sendMissionOverdueSpy = vi.spyOn(emailService, "sendMissionOverdue");
    // Silenced only for tidiness: the disabled-mail branch logs the whole
    // rendered document, which would bury the rest of the suite's output.
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
  });

  afterAll(async () => {
    sendMissionOverdueSpy?.mockRestore();
    infoSpy?.mockRestore();
    if (insertedMissionIds.length > 0) {
      // The notifications go with them: both of `notification`'s foreign keys
      // cascade (see db/schema.ts).
      await getDb().delete(mission).where(inArray(mission.id, insertedMissionIds));
    }
    if (insertedUserIds.length > 0) {
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    scope.missionIds.clear();
    await closeDb();
  });

  it("notifies the pilot once about the mission whose flight window has closed", async () => {
    await runOverdueSweep();

    const rows = await overdueNotifications(overdueMissionId);
    expect(rows).toHaveLength(1);
    // The copy the pilot actually reads, from the real
    // `NewNotification.missionOverdue` factory via the real insert.
    expect(rows[0].title).toBe("Has your flight ended?");
    expect(rows[0].message).toBe(
      `"Overdue ${runId}" has passed its end date. Mark it finished if the flight is done.`,
    );
    // Unread: `notification.readAt` is left null by the insert.
    expect(rows[0].readAt).toBeNull();

    const emails = overdueEmails(overdueMissionId);
    expect(emails).toHaveLength(1);
    expect(emails[0][0]).toEqual({ email: pilotEmail, username: "overdue-sweep-pilot" });
  });

  it("adds nothing on a second sweep over the same rows", async () => {
    // The dedupe under real conditions: this run's `overdueExists` reads the
    // row the previous test committed, so `continue` fires before either side
    // effect — the guarantee the daily schedule depends on.
    await runOverdueSweep();

    expect(await overdueNotifications(overdueMissionId)).toHaveLength(1);
    expect(overdueEmails(overdueMissionId)).toHaveLength(1);
  });

  it("leaves the mission that has not finished flying untouched", async () => {
    // Both sweeps have run by now. `end_time < cutoff` is strict and the cutoff
    // is the start of *today*, so a mission still two days from ending is not
    // overdue — no notification, no email, and its row unchanged.
    expect(await overdueNotifications(futureMissionId)).toEqual([]);
    expect(overdueEmails(futureMissionId)).toEqual([]);

    const [row] = await getDb().select().from(mission).where(eq(mission.id, futureMissionId));
    expect(row.status).toBe("AWARDED");
    expect(row.awardedPilotId).toBe(pilotId);
  });
});

describe.skipIf(hasDb)("overdue-sweep.ts (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
