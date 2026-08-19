import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { mission, rating, users } from "@/db/schema";
import * as queries from "./mission.queries";
import type { OpenMissionQuery } from "./mission.queries";
import type { MissionStatus, MissionWrite } from "./mission.types";

/**
 * Live-DB suite for the mission data-access layer.
 *
 * `mission.queries.ts` is the half of the port that is *only* SQL: the
 * `findOpen` predicates are the ported `Specification` from
 * `JpaMissionDao.findOpen`, `save` reproduces Spring Data's insert-or-merge,
 * and the designer join is a LEFT one specifically so legacy ownerless rows
 * survive it. None of that can be proven by a mocked test — `mission.cache.
 * test.ts` stubs this module out entirely, and `mission.service.test.ts` stubs
 * the DAO — so it is checked here, against the local Postgres that
 * `docker compose up db` starts and Flyway migrates (`MIGRATION_PLAN.md` §8).
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * the same shape as `src/lib/audit.test.ts` and the auth route suite;
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * This module deliberately imports `mission.queries.ts` directly rather than
 * `getMissionDao()`: the caching decorator has its own suite, and the point
 * here is what reaches the database.
 *
 * Every seeded row carries a run-unique tag in its `description`, and every
 * `findOpen` below filters on that tag, so the suite is deterministic against
 * a database that already holds other missions (including a concurrently
 * running `routes.live.test.ts`).
 *
 * There is no Spring counterpart to mirror: the backend has no DAO-level
 * integration test (`CachingMissionDaoTest` mocks `MissionDao`). Each case
 * names the source rule it pins instead.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../data/access/JpaMissionDao.java
 * - drone-missions-backend/.../data/access/OpenMissionQuery.java
 * - drone-missions-backend/.../data/repository/MissionRepository.java
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/** The statuses `MissionService` treats as "open" — supplied by the caller. */
const OPEN_STATUSES: readonly MissionStatus[] = ["PUBLISHED", "BIDDING"];

describe.runIf(hasDb)("mission.queries.ts (live DB)", () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();
  /** Scopes the "which missions come back" cases to this run's core fixtures. */
  const coreTag = `core-${runId}`;
  /** Scopes the flight-window cases to their own fixtures. */
  const edgeTag = `edge-${runId}`;
  /** Scopes the awarded-pilot fixtures to their own cases. */
  const jobsTag = `jobs-${runId}`;

  const insertedUserIds: number[] = [];
  const insertedMissionIds: number[] = [];

  let designerId: number;
  let suspendedDesignerId: number;
  let pilotId: number;
  let otherPilotId: number;
  let unawardedPilotId: number;

  let openPublishedId: number;
  let openBiddingId: number;
  let legacyOwnerlessId: number;
  let draftId: number;
  let hiddenId: number;
  let suspendedOwnedId: number;
  let endsAtFromId: number;
  let insideDayId: number;
  let startsAtToId: number;
  let awardedToPilotId: number;
  let inProgressHiddenPilotId: number;
  let awardedToOtherPilotId: number;

  async function insertUser(
    label: string,
    role: "DESIGNER" | "PILOT",
    suspended = false,
  ): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `queries-${label}`,
        email: `mission-queries-${runId}-${label}@example.com`,
        // A literal, obviously-not-a-hash placeholder: nothing in this suite
        // authenticates, and the column is only NOT NULL.
        passwordHash: "not-a-real-hash",
        role,
        suspended,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id });
    insertedUserIds.push(row.id);
    return row.id;
  }

  /**
   * Inserts a mission row directly, so `created_at` (which `save()` always
   * stamps with "now") can be pinned — the ordering case needs distinct,
   * known values, and a millisecond tie would make it flaky.
   */
  async function insertMission(values: {
    name: string;
    description: string;
    status: MissionStatus;
    moderation?: "VISIBLE" | "HIDDEN";
    userId: number | null;
    awardedPilotId?: number | null;
    location?: string | null;
    startTime?: Date | null;
    endTime?: Date | null;
    createdAt: Date;
  }): Promise<number> {
    const [row] = await getDb()
      .insert(mission)
      .values({
        name: values.name,
        description: values.description,
        status: values.status,
        moderation: values.moderation ?? "VISIBLE",
        userId: values.userId,
        awardedPilotId: values.awardedPilotId ?? null,
        location: values.location ?? null,
        startTime: values.startTime ?? null,
        endTime: values.endTime ?? null,
        createdAt: values.createdAt,
        updatedAt: values.createdAt,
      })
      .returning({ id: mission.id });
    insertedMissionIds.push(row.id);
    return row.id;
  }

  function openQuery(overrides: Partial<OpenMissionQuery> = {}): OpenMissionQuery {
    return {
      statuses: OPEN_STATUSES,
      location: null,
      keyword: coreTag,
      from: null,
      to: null,
      ...overrides,
    };
  }

  /** Local wall-clock, not UTC: the day bounds the service builds are local. */
  function local(year: number, month: number, day: number, hour = 0): Date {
    return new Date(year, month - 1, day, hour);
  }

  /**
   * A complete new mission for the `save`/`delete` cases — every writable
   * column populated, including both `jsonb` ones, so a round trip through
   * Postgres is actually exercised rather than a row of nulls.
   */
  function newDraft(label: string): MissionWrite {
    return {
      name: `${label} mission ${runId}`,
      // Its own tag: rows written by these cases must never widen the
      // `findOpen` expectations above, whatever order the file runs in.
      description: `save-${runId} written by save()`,
      status: "PUBLISHED",
      userId: designerId,
      awardedPilotId: null,
      startTime: local(2026, 9, 3, 8),
      endTime: local(2026, 9, 3, 12),
      location: `Pancevo ${runId}`,
      biddingDeadline: "2026-09-01",
      waypoints: [
        { lat: 45.1, lng: 19.1, altitude: 50, action: "PHOTO" },
        { lat: 45.2, lng: 19.2, altitude: 70, action: "HOVER", hoverDurationSeconds: 15 },
      ],
      geofence: {
        type: "POLYGON",
        points: [
          { lat: 45, lng: 19 },
          { lat: 45.3, lng: 19 },
          { lat: 45.3, lng: 19.3 },
        ],
      },
    };
  }

  beforeAll(async () => {
    designerId = await insertUser("designer", "DESIGNER");
    suspendedDesignerId = await insertUser("suspended", "DESIGNER", true);
    pilotId = await insertUser("pilot", "PILOT");
    otherPilotId = await insertUser("other-pilot", "PILOT");
    unawardedPilotId = await insertUser("unawarded-pilot", "PILOT");

    // Distinct, ordered creation timestamps so `ORDER BY created_at DESC` has
    // exactly one correct answer.
    legacyOwnerlessId = await insertMission({
      name: `legacy ownerless ${runId}`,
      description: `${coreTag} pre-auth row`,
      status: "PUBLISHED",
      // Nullable by design (V4) — an inner join would silently drop this row.
      userId: null,
      location: `Zrenjanin ${runId}`,
      createdAt: local(2026, 1, 1, 1),
    });
    openBiddingId = await insertMission({
      name: `beta tower ${runId}`,
      description: `${coreTag} mast inspection`,
      status: "BIDDING",
      userId: designerId,
      location: `Subotica ${runId}`,
      startTime: local(2026, 9, 2, 9),
      endTime: local(2026, 9, 2, 11),
      createdAt: local(2026, 1, 1, 2),
    });
    openPublishedId = await insertMission({
      name: `alpha bridge ${runId}`,
      description: `${coreTag} north span`,
      status: "PUBLISHED",
      userId: designerId,
      location: `Novi Sad ${runId}`,
      startTime: local(2026, 9, 1, 8),
      endTime: local(2026, 9, 1, 10),
      createdAt: local(2026, 1, 1, 3),
    });
    draftId = await insertMission({
      name: `draft ${runId}`,
      description: `${coreTag} still planning`,
      status: "DRAFT",
      userId: designerId,
      createdAt: local(2026, 1, 1, 4),
    });
    hiddenId = await insertMission({
      name: `hidden ${runId}`,
      description: `${coreTag} moderated away`,
      status: "PUBLISHED",
      moderation: "HIDDEN",
      userId: designerId,
      createdAt: local(2026, 1, 1, 5),
    });
    suspendedOwnedId = await insertMission({
      name: `suspended owner ${runId}`,
      description: `${coreTag} owner is suspended`,
      status: "PUBLISHED",
      userId: suspendedDesignerId,
      createdAt: local(2026, 1, 1, 6),
    });

    // Flight-window fixtures, on their own tag so the cases above stay exact.
    endsAtFromId = await insertMission({
      name: `ends at from ${runId}`,
      description: `${edgeTag} finishes exactly at midnight`,
      status: "PUBLISHED",
      userId: designerId,
      startTime: local(2026, 8, 31, 22),
      endTime: local(2026, 9, 1),
      createdAt: local(2026, 1, 1, 7),
    });
    insideDayId = await insertMission({
      name: `inside day ${runId}`,
      description: `${edgeTag} wholly within the day`,
      status: "PUBLISHED",
      userId: designerId,
      startTime: local(2026, 9, 1, 8),
      endTime: local(2026, 9, 1, 10),
      createdAt: local(2026, 1, 1, 8),
    });
    startsAtToId = await insertMission({
      name: `starts at to ${runId}`,
      description: `${edgeTag} begins exactly at the next midnight`,
      status: "PUBLISHED",
      userId: designerId,
      startTime: local(2026, 9, 2),
      endTime: local(2026, 9, 2, 2),
      createdAt: local(2026, 1, 1, 9),
    });

    // Awarded-pilot fixtures, on their own tag: none of them is in an open
    // status, but the tag keeps them out of the feed cases regardless.
    awardedToPilotId = await insertMission({
      name: `awarded job ${runId}`,
      description: `${jobsTag} won by our pilot`,
      status: "AWARDED",
      userId: designerId,
      awardedPilotId: pilotId,
      createdAt: local(2026, 1, 1, 10),
    });
    inProgressHiddenPilotId = await insertMission({
      name: `hidden job ${runId}`,
      description: `${jobsTag} hidden from the feed after being awarded`,
      status: "IN_PROGRESS",
      // Moderated out of the marketplace, but still this pilot's job.
      moderation: "HIDDEN",
      userId: designerId,
      awardedPilotId: pilotId,
      createdAt: local(2026, 1, 1, 11),
    });
    awardedToOtherPilotId = await insertMission({
      name: `someone else's job ${runId}`,
      description: `${jobsTag} won by a different pilot`,
      status: "AWARDED",
      userId: designerId,
      awardedPilotId: otherPilotId,
      createdAt: local(2026, 1, 1, 12),
    });
  });

  afterAll(async () => {
    if (insertedMissionIds.length > 0) {
      await getDb().delete(mission).where(inArray(mission.id, insertedMissionIds));
    }
    if (insertedUserIds.length > 0) {
      // `fk_mission_user` does not cascade, so the missions above had to go first.
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  describe("findOpen", () => {
    it("returns only open, visible missions from unsuspended designers, newest created first", async () => {
      const found = await queries.findOpen(openQuery());

      // DRAFT (not an open status), HIDDEN (moderation) and the suspended
      // designer's mission are all absent; the legacy ownerless row survives
      // the LEFT join, which an inner one would have dropped.
      expect(found.map((m) => m.id)).toEqual([
        openPublishedId,
        openBiddingId,
        legacyOwnerlessId,
      ]);
      expect(found.map((m) => m.id)).not.toContain(draftId);
      expect(found.map((m) => m.id)).not.toContain(hiddenId);
      expect(found.map((m) => m.id)).not.toContain(suspendedOwnedId);
    });

    it("attaches the designer to each row and leaves it null for an ownerless mission", async () => {
      const found = await queries.findOpen(openQuery());
      const byId = new Map(found.map((m) => [m.id, m]));

      expect(byId.get(openPublishedId)?.designer).toMatchObject({
        id: designerId,
        username: "queries-designer",
        suspended: false,
      });
      expect(byId.get(legacyOwnerlessId)?.designer).toBeNull();
      expect(byId.get(legacyOwnerlessId)?.userId).toBeNull();
    });

    it("honours the caller's status set rather than a hard-coded one", async () => {
      const drafts = await queries.findOpen(openQuery({ statuses: ["DRAFT"] }));

      expect(drafts.map((m) => m.id)).toEqual([draftId]);
    });

    it("matches location case-insensitively", async () => {
      const found = await queries.findOpen(openQuery({ location: `NoVi SaD ${runId}` }));

      // The DAO lowercases both column and pattern (`cb.like(cb.lower(...))`),
      // so a filter the service did not normalise still matches.
      expect(found.map((m) => m.id)).toEqual([openPublishedId]);
    });

    it("matches the keyword against the name or the description", async () => {
      const byName = await queries.findOpen(openQuery({ keyword: `beta tower ${runId}` }));
      const byDescription = await queries.findOpen(
        openQuery({ keyword: `${coreTag} mast inspection` }),
      );

      expect(byName.map((m) => m.id)).toEqual([openBiddingId]);
      expect(byDescription.map((m) => m.id)).toEqual([openBiddingId]);
    });

    it("ANDs the location and keyword filters", async () => {
      const both = await queries.findOpen(
        openQuery({ location: `Subotica ${runId}`, keyword: `alpha bridge ${runId}` }),
      );

      expect(both).toEqual([]);
    });

    it("passes LIKE metacharacters through unescaped, exactly as the source does", async () => {
      // `%` in the filter value widens the match instead of being matched
      // literally — the source builds its pattern the same way, and the feed
      // filter behaves identically there.
      const widened = await queries.findOpen(openQuery({ keyword: `alpha%${runId}` }));

      expect(widened.map((m) => m.id)).toEqual([openPublishedId]);
    });

    it("selects the missions whose flight window overlaps the day, on a half-open boundary", async () => {
      const found = await queries.findOpen(
        openQuery({ keyword: edgeTag, from: local(2026, 9, 1), to: local(2026, 9, 2) }),
      );

      // `endTime >= from` keeps a mission that ends exactly at the day's first
      // instant; `startTime < to` drops one that starts exactly at the next
      // day's, so a mission never lands in two adjacent days by its boundary.
      expect(found.map((m) => m.id).sort()).toEqual([endsAtFromId, insideDayId].sort());
      expect(found.map((m) => m.id)).not.toContain(startsAtToId);
    });

    it("applies no window predicate at all when no date was supplied", async () => {
      const found = await queries.findOpen(openQuery({ keyword: edgeTag }));

      expect(found.map((m) => m.id).sort()).toEqual(
        [endsAtFromId, insideDayId, startsAtToId].sort(),
      );
    });
  });

  describe("findById / findFresh", () => {
    it("both return the same mission with its designer resolved", async () => {
      const cached = await queries.findById(openPublishedId);
      const fresh = await queries.findFresh(openPublishedId);

      expect(cached?.id).toBe(openPublishedId);
      expect(fresh).toEqual(cached);
      expect(cached?.designer?.id).toBe(designerId);
    });

    it("both answer undefined for an id that does not exist", async () => {
      expect(await queries.findById(999_999_999)).toBeUndefined();
      expect(await queries.findFresh(999_999_999)).toBeUndefined();
    });

    it("returns a hidden or draft mission by id — moderation only narrows the feed", async () => {
      expect((await queries.findById(hiddenId))?.moderation).toBe("HIDDEN");
      expect((await queries.findById(draftId))?.status).toBe("DRAFT");
    });
  });

  describe("findByUserId", () => {
    it("returns every mission the user created, whatever its status or moderation", async () => {
      const found = await queries.findByUserId(designerId);
      const ids = found.map((m) => m.id);

      expect(ids).toEqual(expect.arrayContaining([openPublishedId, draftId, hiddenId]));
      expect(ids).not.toContain(legacyOwnerlessId);
      expect(ids).not.toContain(suspendedOwnedId);
    });

    it("returns nothing for a user who owns no missions", async () => {
      expect(await queries.findByUserId(pilotId)).toEqual([]);
    });
  });

  describe("findByAwardedPilotId", () => {
    it("returns every mission awarded to this pilot, whatever its status or moderation", async () => {
      const found = await queries.findByAwardedPilotId(pilotId);
      const ids = found.map((m) => m.id);

      // Both of the pilot's jobs come back: the HIDDEN one included, because
      // `findByAwardedPilot_Id` carries no moderation filter — HIDDEN only
      // narrows the open feed, and a pilot keeps the job they won even after
      // it has been moderated out of the marketplace.
      expect(ids.sort()).toEqual([awardedToPilotId, inProgressHiddenPilotId].sort());
      expect(found.find((m) => m.id === inProgressHiddenPilotId)?.moderation).toBe("HIDDEN");
    });

    it("scopes the listing to the awarded pilot", async () => {
      const found = await queries.findByAwardedPilotId(pilotId);
      const ids = found.map((m) => m.id);

      // Another pilot's job, and the unawarded missions this designer owns,
      // are all absent.
      expect(ids).not.toContain(awardedToOtherPilotId);
      expect(ids).not.toContain(openPublishedId);
      expect(ids).not.toContain(draftId);
    });

    it("reads awarded_pilot_id, not user_id", async () => {
      // The two listings answer different questions about the same person:
      // the designer created these missions but was awarded none of them,
      // while the pilot was awarded two and created none.
      expect(await queries.findByAwardedPilotId(designerId)).toEqual([]);
      expect(await queries.findByUserId(pilotId)).toEqual([]);

      const designed = (await queries.findByUserId(designerId)).map((m) => m.id);
      expect(designed).toEqual(expect.arrayContaining([awardedToPilotId]));
    });

    it("attaches the designer, not the pilot, to each row", async () => {
      const found = await queries.findByAwardedPilotId(pilotId);

      // The same LEFT designer join every other read uses: the pilot's
      // my-jobs response still names who commissioned the mission.
      expect(found[0]?.designer).toMatchObject({ id: designerId, username: "queries-designer" });
      expect(found.every((m) => m.awardedPilotId === pilotId)).toBe(true);
    });

    it("returns nothing for a pilot who has been awarded no missions", async () => {
      expect(await queries.findByAwardedPilotId(unawardedPilotId)).toEqual([]);
    });
  });

  describe("save", () => {
    it("inserts when the id is absent, stamps both timestamps and defaults moderation", async () => {
      const saved = await queries.save(newDraft("inserted"));
      insertedMissionIds.push(saved.id);

      expect(saved.id).toEqual(expect.any(Number));
      expect(saved.moderation).toBe("VISIBLE");
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.updatedAt).toBeInstanceOf(Date);
      // Re-read through the designer join, not assembled from the write.
      expect(saved.designer?.id).toBe(designerId);
      // The two `jsonb` columns survive the round trip narrowed, not stringified.
      expect(saved.waypoints).toHaveLength(2);
      expect(saved.geofence).toEqual({
        type: "POLYGON",
        points: [
          { lat: 45, lng: 19 },
          { lat: 45.3, lng: 19 },
          { lat: 45.3, lng: 19.3 },
        ],
      });
      // A `LocalDate` column comes back as a calendar day, never an instant.
      expect(saved.biddingDeadline).toBe("2026-09-01");
    });

    it("merges every column when the id is present, keeping created_at and advancing updated_at", async () => {
      const inserted = await queries.save(newDraft("merged"));
      insertedMissionIds.push(inserted.id);

      const merged = await queries.save({
        ...inserted,
        name: `merged mission ${runId}`,
        location: null,
        waypoints: null,
        geofence: null,
        // Spring Data's `save()` merges the *whole* object — a status carried
        // in from the loaded row is written back, which is exactly why a
        // mutating flow must load through `findFresh`.
        status: "BIDDING",
      });

      expect(merged.id).toBe(inserted.id);
      expect(merged.name).toBe(`merged mission ${runId}`);
      expect(merged.status).toBe("BIDDING");
      expect(merged.location).toBeNull();
      expect(merged.waypoints).toBeNull();
      expect(merged.geofence).toBeNull();
      // `created_at` is `updatable = false` on the Java entity.
      expect(merged.createdAt.getTime()).toBe(inserted.createdAt.getTime());
      expect(merged.updatedAt.getTime()).toBeGreaterThanOrEqual(inserted.updatedAt.getTime());
    });

    it("fails loudly when the row it was told to merge no longer exists", async () => {
      const inserted = await queries.save(newDraft("ghost"));
      await getDb().delete(mission).where(eq(mission.id, inserted.id));

      await expect(queries.save({ ...inserted, name: "ghost" })).rejects.toThrow(
        `Mission ${inserted.id} no longer exists`,
      );
    });
  });

  describe("delete", () => {
    it("removes the row and takes its ratings with it through the cascading FK", async () => {
      const doomed = await queries.save(newDraft("doomed"));
      await getDb().insert(rating).values({
        missionId: doomed.id,
        raterId: pilotId,
        rateeId: designerId,
        score: 4,
        createdAt: new Date(),
      });

      await queries.deleteMission({ id: doomed.id });

      expect(await queries.findById(doomed.id)).toBeUndefined();
      expect(await getDb().select().from(rating).where(eq(rating.missionId, doomed.id))).toEqual(
        [],
      );
    });
  });
});

describe.skipIf(hasDb)("mission.queries.ts (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
