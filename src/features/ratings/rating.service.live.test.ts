import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, mission, rating, users } from "@/db/schema";
import { getMissionDao } from "@/features/missions/mission.cache";
import {
  AlreadyRatedError,
  NotMissionParticipantError,
  RatingNotYetAllowedError,
  create,
  forMission,
  receivedBy,
} from "./rating.service";

/**
 * Live-DB round-trip for `rating.service.ts` — the half `rating.service.test.ts`
 * structurally cannot show.
 *
 * That suite stubs the query module and `record()`, so it proves the policy
 * (guard order, counterpart resolution, what is written when a rating is
 * refused) but never that a `create` actually lands: the rating row, the
 * `audit_log` row it triggers, and the joined names on the row handed back are
 * all properties of real SQL. This suite runs the unmodified service against
 * the local Postgres `MIGRATION_PLAN.md` §8 sets up — the same live-DB shape as
 * `rating.queries.test.ts` and the sibling `bid.service.live.test.ts`.
 *
 * Two things here are covered nowhere else:
 *
 *  - the **audit write** for `RATING_CREATED`. `audit.test.ts`'s live section
 *    exercises only the two user factories, and `rating.service.test.ts` spies
 *    on `record()` rather than calling it, so this is the only place the
 *    derived actor role is checked against `audit_log_actor_role_check` and the
 *    `fk_audit_log_actor` foreign key;
 *  - **who refuses the second rating**. `rating.queries.test.ts` pins the
 *    database's own `rating_mission_rater_unique` backstop; what matters at
 *    this layer is that the caller never reaches it — `existsByMissionAndRater`
 *    turns the second attempt into `AlreadyRatedError` (a 409 the Angular toast
 *    can read) rather than a raw constraint violation (a 500).
 *
 * Unlike its bid/mission siblings there is no rollback case, and no injected
 * failure: no method of the Java `RatingService` is `@Transactional` — `create`
 * writes one row and then audits it — so there is no atomicity claim to test.
 *
 * The backend has no counterpart to mirror; `RatingServiceTest` is a pure
 * Mockito unit test. Each case names the `RatingService` rule it pins instead.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../business/service/rating/RatingService.java
 * - drone-missions-backend/.../business/service/audit/NewAuditEntry.java (`ratingCreated`)
 * - drone-missions-backend/.../src/main/resources/db/migration/V11__create_rating_table.sql
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("rating.service.ts create (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();

  const insertedUserIds: number[] = [];
  const insertedMissionIds: number[] = [];

  let designerId: number;
  let pilotId: number;
  /** Neither side of any mission here — the participant gate's negative case. */
  let outsiderId: number;

  /** COMPLETED, and the mission both sides rate. */
  let deliveredId: number;
  /** COMPLETED, rated only by the designer — so `receivedBy` spans missions. */
  let secondJobId: number;
  /** IN_PROGRESS — nothing to rate yet. */
  let runningId: number;

  const deliveredName = `Delivered survey ${runId}`;

  async function insertUser(label: string, role: "DESIGNER" | "PILOT"): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `rating-service-${label}-${runId}`,
        email: `rating-service-${runId}-${label}@example.com`,
        // A literal, obviously-not-a-hash placeholder: nothing in this suite
        // authenticates, and the column is only NOT NULL.
        passwordHash: "not-a-real-hash",
        role,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id });
    insertedUserIds.push(row.id);
    return row.id;
  }

  async function insertMission(values: {
    name: string;
    status: "COMPLETED" | "IN_PROGRESS";
  }): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(mission)
      .values({
        name: values.name,
        description: `rating-service-${runId}`,
        status: values.status,
        moderation: "VISIBLE",
        userId: designerId,
        awardedPilotId: pilotId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: mission.id });
    insertedMissionIds.push(row.id);
    return row.id;
  }

  /** Every audit row this run's users produced, newest last. */
  async function auditRowsFor(actorId: number) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, actorId), eq(auditLog.action, "RATING_CREATED")));
  }

  beforeAll(async () => {
    designerId = await insertUser("designer", "DESIGNER");
    pilotId = await insertUser("pilot", "PILOT");
    outsiderId = await insertUser("outsider", "PILOT");

    deliveredId = await insertMission({ name: deliveredName, status: "COMPLETED" });
    secondJobId = await insertMission({ name: `Second job ${runId}`, status: "COMPLETED" });
    runningId = await insertMission({ name: `Running job ${runId}`, status: "IN_PROGRESS" });
  });

  afterAll(async () => {
    if (insertedUserIds.length > 0) {
      // Audit rows first: `fk_audit_log_actor` does not cascade.
      await getDb().delete(auditLog).where(inArray(auditLog.actorId, insertedUserIds));
    }
    if (insertedMissionIds.length > 0) {
      // `fk_rating_mission ON DELETE CASCADE` would take the ratings anyway;
      // they go explicitly so nothing depends on the cascade staying.
      await getDb().delete(rating).where(inArray(rating.missionId, insertedMissionIds));
      await getDb().delete(mission).where(inArray(mission.id, insertedMissionIds));
      // The cached DAO holds the missions this suite read; drop them so a
      // later suite in the same process never sees a deleted row.
      for (const id of insertedMissionIds) {
        getMissionDao().invalidate(id);
      }
    }
    if (insertedUserIds.length > 0) {
      // `fk_rating_rater`/`fk_rating_ratee` and `fk_mission_user` do not
      // cascade, so both of the above had to go first.
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  it("writes the designer's rating of the awarded pilot, with the joined names on the row", async () => {
    const saved = await create(deliveredId, designerId, 5, "Clean pass, delivered a day early");

    // Identity-generated (V11) — the row exists as far as the database is
    // concerned, which is what the audit entry below depends on.
    expect(saved.id).toBeGreaterThan(0);
    expect(saved.missionId).toBe(deliveredId);
    expect(saved.raterId).toBe(designerId);
    // Never supplied by the caller: derived from the mission row.
    expect(saved.rateeId).toBe(pilotId);
    expect(saved.score).toBe(5);
    expect(saved.comment).toBe("Clean pass, delivered a day early");
    // The two names `RatingMapper` reads off the JPA relations, materialised by
    // the query layer's joins rather than by an N+1 of lookups.
    expect(saved.mission.name).toBe(deliveredName);
    expect(saved.rater.username).toContain("rating-service-designer");

    const [stored] = await getDb().select().from(rating).where(eq(rating.id, saved.id));
    expect(stored).toMatchObject({ missionId: deliveredId, raterId: designerId, rateeId: pilotId });
    // Stamped by the insert (the column has no default; `@CreationTimestamp`
    // does it on the Java side) and never updated afterwards.
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  it("records one RATING_CREATED row, actored by the designer with the DESIGNER role", async () => {
    const [entry, ...extra] = await auditRowsFor(designerId);

    expect(extra).toEqual([]);
    expect(entry).toMatchObject({
      actorId: designerId,
      // Derived, not constant: both sides of a completed mission may rate, so
      // the entry has to say which side this one was.
      actorRole: "DESIGNER",
      action: "RATING_CREATED",
      targetType: "RATING",
      details: `5/5 on "${deliveredName}"`,
    });
    // The identity id the insert assigned — the entry can only be built from
    // the saved row, which is why `create` audits after the write.
    const [stored] = await getDb()
      .select()
      .from(rating)
      .where(and(eq(rating.missionId, deliveredId), eq(rating.raterId, designerId)));
    expect(entry.targetId).toBe(stored.id);
  });

  it("refuses the same rater's second rating before the unique constraint has to", async () => {
    // `existsByMissionAndRater` answers first, so the caller gets the 409 the
    // Angular toast can read rather than a `rating_mission_rater_unique`
    // violation surfacing as a 500. (The constraint itself, as the backstop for
    // two creates racing past this check, is pinned in `rating.queries.test.ts`.)
    await expect(create(deliveredId, designerId, 1, "changed my mind")).rejects.toBeInstanceOf(
      AlreadyRatedError,
    );

    // Ratings are final: the first score stands and nothing new was written.
    const rows = await getDb()
      .select()
      .from(rating)
      .where(and(eq(rating.missionId, deliveredId), eq(rating.raterId, designerId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(5);
    expect(await auditRowsFor(designerId)).toHaveLength(1);
  });

  it("writes the pilot's rating of the designer with the PILOT role derived", async () => {
    const saved = await create(deliveredId, pilotId, 4, null);

    expect(saved.rateeId).toBe(designerId);
    expect(saved.comment).toBeNull();

    const [entry, ...extra] = await auditRowsFor(pilotId);
    expect(extra).toEqual([]);
    expect(entry).toMatchObject({
      actorId: pilotId,
      actorRole: "PILOT",
      targetId: saved.id,
      details: `4/5 on "${deliveredName}"`,
    });
  });

  it("hands both sides' ratings to a participant, newest first, and refuses an outsider", async () => {
    const ratings = await forMission(deliveredId, designerId);

    expect(ratings.map((row) => row.raterId)).toEqual([pilotId, designerId]);
    expect(await forMission(deliveredId, pilotId)).toHaveLength(2);
    await expect(forMission(deliveredId, outsiderId)).rejects.toBeInstanceOf(
      NotMissionParticipantError,
    );
  });

  it("collects a user's received ratings across missions, ungated", async () => {
    await create(secondJobId, designerId, 3, null);

    // Both were *received* by the pilot, on two different missions, and the
    // caller is the outsider — a reputation is public.
    const received = await receivedBy(pilotId);
    expect(received.map((row) => row.missionId)).toEqual([secondJobId, deliveredId]);
    expect(received.map((row) => row.mission.name)).toEqual([`Second job ${runId}`, deliveredName]);
  });

  it("writes nothing at all for a mission that is not COMPLETED", async () => {
    await expect(create(runningId, designerId, 5, null)).rejects.toBeInstanceOf(
      RatingNotYetAllowedError,
    );

    expect(await getDb().select().from(rating).where(eq(rating.missionId, runningId))).toEqual([]);
    // A rejected rating audits nothing — the entry is built from a saved row
    // that never came into being.
    expect(await auditRowsFor(designerId)).toHaveLength(2);
  });
});

describe.skipIf(hasDb)("rating.service.ts create (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
