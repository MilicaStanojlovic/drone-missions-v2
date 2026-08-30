import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { mission, rating, users } from "@/db/schema";
import * as queries from "@/features/ratings/server/rating.queries";

/**
 * Live-DB suite for the rating data-access layer.
 *
 * `rating.queries.ts` is the half of the ratings port that is *only* SQL, and
 * every one of its load-bearing behaviours is invisible to a mocked test:
 *
 *  - the mission/rater INNER joins that materialise the two names
 *    `RatingMapper` reads off the JPA relations ("the relations carry the
 *    names, so the mapper reads them off the entity rather than looking each
 *    one up") — without them the mapper would be back to an N+1;
 *  - `ORDER BY created_at DESC`, which `rating.service.test.ts` can only
 *    assume;
 *  - `rating_mission_rater_unique` (V11) standing behind `insertRating` — the
 *    constraint that makes a rating final, and the backstop for two `create`
 *    calls racing past `existsByMissionAndRater`;
 *  - `rating_score_check` (V11) confining a score to 1–5 in the database, not
 *    only in Zod;
 *  - `summariesFor`'s `GROUP BY`, whose "unrated users are absent rather than
 *    zero" contract is what `MissionController.ratingOf` (and `summaryOf`) is
 *    written against — until now exercised only against a stubbed module in
 *    `mission.mapper.test.ts`.
 *
 * Run against the Flyway-migrated Postgres configured in `DATABASE_URL`
 * (`MIGRATION_PLAN.md` §8), following the shape of
 * `tests/features/bids/server/bid.queries.test.ts`. Skipped, with a visible reason,
 * when `DATABASE_URL` isn't configured — `vitest.config.ts` forwards the
 * variable from `.env.local`/`.env`.
 *
 * Every row this suite writes is owned by users it created for this run, and
 * every assertion is scoped to those ids, so it is deterministic against a
 * database that already holds other ratings.
 *
 * There is no Spring counterpart to mirror: the backend has no
 * repository-level integration test. Each case names the source rule it pins
 * instead.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../data/repository/RatingRepository.java
 * - drone-missions-backend/.../data/model/Rating.java
 * - drone-missions-backend/.../web/mapper/rating/RatingMapper.java
 * - drone-missions-backend/.../business/service/rating/RatingService.java
 * - drone-missions-backend/.../src/main/resources/db/migration/V11__create_rating_table.sql
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("rating.queries.ts (live DB)", () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();

  const insertedUserIds: number[] = [];
  const insertedMissionIds: number[] = [];
  const insertedRatingIds: number[] = [];

  let designerId: number;
  let pilotId: number;
  /** Rated by nobody — the "absent, not zero" case for the aggregates. */
  let outsiderId: number;
  /**
   * Ratee for everything the `insertRating` cases write, so the rows they add
   * never move the designer's or the pilot's aggregate out from under the
   * `summariesFor` cases.
   */
  let insertTargetId: number;

  /** The mission carrying both directions of a rating. */
  let bridgeId: number;
  /** A second completed mission, so "this mission's ratings" is a real filter. */
  let towerId: number;
  /** Hidden after the fact — a review of it still shows on the profile. */
  let hiddenId: number;

  /** bridge: designer -> pilot, the older of the two. */
  let bridgeOfPilotId: number;
  /** bridge: pilot -> designer, the newer of the two. */
  let bridgeOfDesignerId: number;
  /** tower: designer -> pilot. */
  let towerOfPilotId: number;
  /** hidden: designer -> pilot, the newest rating the pilot received. */
  let hiddenOfPilotId: number;

  async function insertUser(label: string, role: "DESIGNER" | "PILOT"): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `rating-queries-${label}`,
        email: `rating-queries-${runId}-${label}@example.com`,
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
    moderation?: "VISIBLE" | "HIDDEN";
  }): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(mission)
      .values({
        name: values.name,
        description: `rating-queries-${runId}`,
        // Ratings only ever exist on a completed mission (the service's own
        // gate), so the fixtures say so even though no query here reads it.
        status: "COMPLETED",
        moderation: values.moderation ?? "VISIBLE",
        userId: designerId,
        awardedPilotId: pilotId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: mission.id });
    insertedMissionIds.push(row.id);
    return row.id;
  }

  /**
   * Inserts a rating row directly, so `created_at` — which `insertRating()`
   * always stamps with "now" — can be pinned. The ordering cases need
   * distinct, known values; a millisecond tie would make them flaky.
   */
  async function insertRatingRow(values: {
    missionId: number;
    raterId: number;
    rateeId: number;
    score: number;
    comment?: string | null;
    createdAt: Date;
  }): Promise<number> {
    const [row] = await getDb()
      .insert(rating)
      .values({
        missionId: values.missionId,
        raterId: values.raterId,
        rateeId: values.rateeId,
        score: values.score,
        comment: values.comment ?? null,
        createdAt: values.createdAt,
      })
      .returning({ id: rating.id });
    insertedRatingIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    designerId = await insertUser("designer", "DESIGNER");
    pilotId = await insertUser("pilot", "PILOT");
    outsiderId = await insertUser("outsider", "PILOT");
    insertTargetId = await insertUser("insert-target", "DESIGNER");

    bridgeId = await insertMission({ name: `Bridge survey ${runId}` });
    towerId = await insertMission({ name: `Tower inspection ${runId}` });
    hiddenId = await insertMission({ name: `Hidden job ${runId}`, moderation: "HIDDEN" });

    // Both sides of one mission, with distinct timestamps so "newest first"
    // has exactly one correct answer.
    bridgeOfPilotId = await insertRatingRow({
      missionId: bridgeId,
      raterId: designerId,
      rateeId: pilotId,
      score: 5,
      comment: "Clean photogrammetry pass, delivered a day early",
      createdAt: new Date("2026-01-01T10:00:00Z"),
    });
    bridgeOfDesignerId = await insertRatingRow({
      missionId: bridgeId,
      raterId: pilotId,
      rateeId: designerId,
      score: 4,
      createdAt: new Date("2026-01-01T11:00:00Z"),
    });
    towerOfPilotId = await insertRatingRow({
      missionId: towerId,
      raterId: designerId,
      rateeId: pilotId,
      score: 3,
      createdAt: new Date("2026-01-02T09:00:00Z"),
    });
    hiddenOfPilotId = await insertRatingRow({
      missionId: hiddenId,
      raterId: designerId,
      rateeId: pilotId,
      score: 2,
      createdAt: new Date("2026-01-03T09:00:00Z"),
    });
  });

  afterAll(async () => {
    if (insertedMissionIds.length > 0) {
      // `fk_rating_mission ON DELETE CASCADE` would take the ratings anyway;
      // they go explicitly so a rating on a mission this suite did not create
      // (there are none today) could never be orphaned by a future edit.
      if (insertedRatingIds.length > 0) {
        await getDb().delete(rating).where(inArray(rating.id, insertedRatingIds));
      }
      await getDb().delete(mission).where(inArray(mission.id, insertedMissionIds));
    }
    if (insertedUserIds.length > 0) {
      // `fk_rating_rater`/`fk_rating_ratee` and `fk_mission_user` do not
      // cascade, so both of the above had to go first.
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  describe("existsByMissionAndRater", () => {
    it("is true only for the (mission, rater) pair that has actually rated", async () => {
      // The check `RatingService.create` makes before building the row: what
      // turns a second attempt into AlreadyRatedException rather than a
      // constraint violation.
      expect(await queries.existsByMissionAndRater(bridgeId, designerId)).toBe(true);
      expect(await queries.existsByMissionAndRater(bridgeId, pilotId)).toBe(true);

      // Same rater, a mission they have not rated.
      expect(await queries.existsByMissionAndRater(towerId, pilotId)).toBe(false);
      // Same mission, a rater who has not rated it.
      expect(await queries.existsByMissionAndRater(bridgeId, outsiderId)).toBe(false);
    });
  });

  describe("findByMissionId", () => {
    it("returns both ratings on the mission, newest first, each with its own rater's name", async () => {
      const found = await queries.findByMissionId(bridgeId);

      expect(found.map((r) => r.id)).toEqual([bridgeOfDesignerId, bridgeOfPilotId]);
      // `RatingMapper` reads these two off the JPA relations; the join is what
      // keeps that from being an N+1 of mission/user lookups here.
      expect(found.map((r) => r.rater.username)).toEqual([
        "rating-queries-pilot",
        "rating-queries-designer",
      ]);
      expect(found.every((r) => r.mission.name === `Bridge survey ${runId}`)).toBe(true);
      expect(found[1]).toMatchObject({
        missionId: bridgeId,
        raterId: designerId,
        rateeId: pilotId,
        score: 5,
        comment: "Clean photogrammetry pass, delivered a day early",
      });
      expect(found[0].comment).toBeNull();
      expect(found[0].createdAt).toBeInstanceOf(Date);
    });

    it("returns nothing from another mission, and the empty list for an unrated one", async () => {
      const found = await queries.findByMissionId(bridgeId);
      expect(found.map((r) => r.id)).not.toContain(towerOfPilotId);

      const unrated = await insertMission({ name: `Unrated ${runId}` });
      expect(await queries.findByMissionId(unrated)).toEqual([]);
    });

    it("selects no password hash and no flight plan into a rating row", async () => {
      const [first] = await queries.findByMissionId(bridgeId);

      // The joins take `users.id/username` and `mission.id/name` only: a
      // rating list must never carry a credential column, nor a mission's two
      // `jsonb` columns once per rating.
      expect(Object.keys(first.rater).sort()).toEqual(["id", "username"]);
      expect(Object.keys(first.mission).sort()).toEqual(["id", "name"]);
      // The ratee is a bare id — the mapper emits no ratee name.
      expect(first).not.toHaveProperty("ratee");
    });
  });

  describe("findByRateeId", () => {
    it("returns the ratings a user received across missions, newest first, with each mission's name", async () => {
      const found = await queries.findByRateeId(pilotId);

      expect(found.map((r) => r.id)).toEqual([hiddenOfPilotId, towerOfPilotId, bridgeOfPilotId]);
      expect(found.map((r) => r.mission.name)).toEqual([
        `Hidden job ${runId}`,
        `Tower inspection ${runId}`,
        `Bridge survey ${runId}`,
      ]);
      // Received, not given: the rating this pilot wrote about the designer is
      // on the designer's profile, not their own.
      expect(found.every((r) => r.rateeId === pilotId)).toBe(true);
      expect(found.map((r) => r.id)).not.toContain(bridgeOfDesignerId);
    });

    it("keeps a review of a hidden mission — the source applies no moderation filter here", async () => {
      const found = await queries.findByRateeId(pilotId);

      // A mission being moderated away afterwards must not silently erase what
      // someone wrote about the person who flew it.
      expect(found.map((r) => r.id)).toContain(hiddenOfPilotId);
    });

    it("returns the empty list for a user nobody has rated", async () => {
      expect(await queries.findByRateeId(outsiderId)).toEqual([]);
    });
  });

  describe("insertRating", () => {
    it("inserts, stamps created_at, and returns the row with its identity id and joined names", async () => {
      const newcomer = await insertUser("inserting", "PILOT");
      const before = Date.now();

      const saved = await queries.insertRating({
        missionId: towerId,
        raterId: newcomer,
        rateeId: insertTargetId,
        score: 4,
        comment: "Clear brief, prompt answers",
      });
      insertedRatingIds.push(saved.id);

      expect(saved.id).toEqual(expect.any(Number));
      expect(saved.score).toBe(4);
      expect(saved.comment).toBe("Clear brief, prompt answers");
      // No database default on the column: `@CreationTimestamp`'s job, done
      // here.
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      // Re-read through the joins, not assembled from the write — the mapper
      // needs both names.
      expect(saved.mission).toEqual({ id: towerId, name: `Tower inspection ${runId}` });
      expect(saved.rater).toEqual({ id: newcomer, username: "rating-queries-inserting" });
    });

    it("stores an absent comment as null", async () => {
      const newcomer = await insertUser("terse", "PILOT");

      const saved = await queries.insertRating({
        missionId: towerId,
        raterId: newcomer,
        rateeId: insertTargetId,
        score: 5,
        comment: null,
      });
      insertedRatingIds.push(saved.id);

      expect(saved.comment).toBeNull();
    });

    it("is rejected by rating_mission_rater_unique when the same rater rates the mission twice", async () => {
      const newcomer = await insertUser("racing", "PILOT");
      const first = await queries.insertRating({
        missionId: bridgeId,
        raterId: newcomer,
        rateeId: insertTargetId,
        score: 5,
        comment: null,
      });
      insertedRatingIds.push(first.id);

      // What two `create` calls racing past `existsByMissionAndRater` would
      // both reach. There is no `ON CONFLICT` clause — the source has no
      // equivalent — so the constraint rejects the loser rather than a second
      // rating slipping through. This is also what makes a rating final.
      const rejection = await queries
        .insertRating({
          missionId: bridgeId,
          raterId: newcomer,
          rateeId: insertTargetId,
          score: 1,
          comment: "Changed my mind",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      // Drizzle's thrown error quotes the failed statement; the constraint that
      // actually stopped it is on the driver error underneath, which is what
      // this case is really about.
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
        "rating_mission_rater_unique",
      );

      expect(await getDb().select().from(rating).where(eq(rating.raterId, newcomer))).toHaveLength(
        1,
      );
    });

    it("is rejected by rating_score_check for a score outside 1–5", async () => {
      const newcomer = await insertUser("shouting", "PILOT");

      // The database, not only the Zod schema, confines a score to 1–5.
      const rejection = await queries
        .insertRating({
          missionId: towerId,
          raterId: newcomer,
          rateeId: insertTargetId,
          score: 6,
          comment: null,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect((rejection as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
        "rating_score_check",
      );
      expect(await getDb().select().from(rating).where(eq(rating.raterId, newcomer))).toEqual([]);
    });
  });

  describe("summariesFor / summaryFor (the phase-2 aggregates, against real SQL)", () => {
    it("groups by ratee and leaves unrated users out of the map rather than at zero", async () => {
      const summaries = await queries.summariesFor([pilotId, designerId, outsiderId]);

      // The pilot's three received ratings: 5, 3 and 2.
      expect(summaries.get(pilotId)?.count).toBe(3);
      expect(summaries.get(pilotId)?.average).toBeCloseTo(10 / 3, 10);
      expect(summaries.get(designerId)).toEqual({ average: 4, count: 1 });
      // Absent, not zero — callers decide what "unrated" looks like.
      expect(summaries.has(outsiderId)).toBe(false);

      // `avg`/`count` arrive from postgres.js as strings; the narrowing happens
      // exactly once, here at the DAO boundary.
      expect(typeof summaries.get(designerId)?.average).toBe("number");
      expect(typeof summaries.get(designerId)?.count).toBe("number");
    });

    it("answers NONE for an unrated user and for a null id, without a query for the empty case", async () => {
      expect(await queries.summaryFor(outsiderId)).toEqual({ average: 0, count: 0 });
      // `mission.user_id` is nullable for pre-auth rows, so a null owner id is
      // a legitimate input rather than a bug.
      expect(await queries.summaryFor(null)).toEqual(queries.RATING_SUMMARY_NONE);
      // `WHERE ratee_id IN ()` is not valid SQL — the empty input never gets
      // that far.
      expect(await queries.summariesFor([])).toEqual(new Map());
    });
  });
});

describe.skipIf(hasDb)("rating.queries.ts (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
