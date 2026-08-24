import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { bid, mission, users, type BidStatus } from "@/db/schema";
import * as queries from "@/features/bids/bid.queries";

/**
 * Live-DB suite for the bid data-access layer.
 *
 * `bid.queries.ts` is the half of the phase-3 port that is *only* SQL, and
 * every one of its load-bearing behaviours is invisible to a mocked test:
 *
 *  - the mission/pilot INNER joins that materialise `missionName`/`pilotName`
 *    in one statement — the whole point of `BidMapper`'s "the per-bid lookups
 *    this used to do are gone";
 *  - `save()` reproducing Spring Data's insert-or-merge, with
 *    `bid_mission_pilot_unique` (V8) standing behind it: a second save of the
 *    *same* pilot's bid must update the row rather than add one, and a racing
 *    insert must be rejected by the constraint rather than duplicated;
 *  - `numeric(12, 2)` round-tripping — Drizzle hands the column back as
 *    decimal *text* and the DAO narrows it to a `number` exactly once, with
 *    the column's scale applied by Postgres (the same place a JDBC
 *    `BigDecimal` gets it);
 *  - `ORDER BY created_at DESC`, which `bid.service.test.ts` can only assume.
 *
 * `bid.service.test.ts` stubs this module out entirely, so none of the above
 * is proven there. It is checked here instead, against the local Postgres that
 * `docker compose up db` starts and Flyway migrates (`MIGRATION_PLAN.md` §8),
 * following the shape of `src/features/missions/mission.queries.test.ts`.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * Every row this suite writes is owned by users it created for this run, and
 * every assertion is scoped to those ids, so it is deterministic against a
 * database that already holds other bids (including a concurrently running
 * `src/app/api/v1/bids/routes.live.test.ts`).
 *
 * There is no Spring counterpart to mirror: the backend has no repository-level
 * integration test. Each case names the source rule it pins instead.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../data/repository/BidRepository.java
 * - drone-missions-backend/.../data/model/Bid.java
 * - drone-missions-backend/.../web/mapper/bid/BidMapper.java
 * - drone-missions-backend/.../business/service/bid/BidService.java (`place`, `withdraw`)
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("bid.queries.ts (live DB)", () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();

  const insertedUserIds: number[] = [];
  const insertedMissionIds: number[] = [];
  const insertedBidIds: number[] = [];

  let designerId: number;
  let pilotId: number;
  let otherPilotId: number;

  /** The mission carrying the ordering/join fixtures. */
  let bridgeId: number;
  /** A second mission, so "this mission's bids" is a real filter. */
  let towerId: number;
  /** Hidden after the fact — a pilot still sees their own bid on it. */
  let hiddenId: number;

  let oldestBidId: number;
  let middleBidId: number;
  let newestBidId: number;
  let otherMissionBidId: number;
  let hiddenMissionBidId: number;

  async function insertUser(
    label: string,
    role: "DESIGNER" | "PILOT",
    suspended = false,
  ): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `bid-queries-${label}`,
        email: `bid-queries-${runId}-${label}@example.com`,
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

  async function insertMission(values: {
    name: string;
    moderation?: "VISIBLE" | "HIDDEN";
  }): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(mission)
      .values({
        name: values.name,
        description: `bid-queries-${runId}`,
        status: "PUBLISHED",
        moderation: values.moderation ?? "VISIBLE",
        userId: designerId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: mission.id });
    insertedMissionIds.push(row.id);
    return row.id;
  }

  /**
   * Inserts a bid row directly, so `created_at` — which `save()` always stamps
   * with "now" — can be pinned. The ordering cases need distinct, known
   * values; a millisecond tie would make them flaky.
   */
  async function insertBid(values: {
    missionId: number;
    pilotId: number;
    amount: string;
    message?: string | null;
    status?: BidStatus;
    createdAt: Date;
  }): Promise<number> {
    const [row] = await getDb()
      .insert(bid)
      .values({
        missionId: values.missionId,
        pilotId: values.pilotId,
        amount: values.amount,
        message: values.message ?? null,
        status: values.status ?? "PENDING",
        createdAt: values.createdAt,
        updatedAt: values.createdAt,
      })
      .returning({ id: bid.id });
    insertedBidIds.push(row.id);
    return row.id;
  }

  /**
   * The platform's bid totals as they stood *before* this file inserted
   * anything — captured by a hook registered ahead of the fixture hook below,
   * which is what makes it a reading of a database this suite has not touched
   * yet. On the clean local/CI database (`docker compose up db` + Flyway, no
   * migration seeds a bid) that reading is the `volume()` empty case; see the
   * case that consumes it.
   */
  let baselineVolume: Awaited<ReturnType<typeof queries.volume>>;

  beforeAll(async () => {
    baselineVolume = await queries.volume();
  });

  beforeAll(async () => {
    designerId = await insertUser("designer", "DESIGNER");
    pilotId = await insertUser("pilot", "PILOT");
    otherPilotId = await insertUser("other-pilot", "PILOT");

    bridgeId = await insertMission({ name: `Bridge survey ${runId}` });
    towerId = await insertMission({ name: `Tower inspection ${runId}` });
    hiddenId = await insertMission({ name: `Hidden job ${runId}`, moderation: "HIDDEN" });

    // Three bids on one mission with distinct, ordered timestamps, so
    // `ORDER BY created_at DESC` has exactly one correct answer. Two pilots
    // are involved because the unique constraint allows only one bid each.
    oldestBidId = await insertBid({
      missionId: bridgeId,
      pilotId,
      amount: "1200.00",
      message: "Two-day photogrammetry pass",
      createdAt: new Date("2026-01-01T09:00:00Z"),
    });
    middleBidId = await insertBid({
      missionId: bridgeId,
      pilotId: otherPilotId,
      amount: "999.50",
      createdAt: new Date("2026-01-01T10:00:00Z"),
    });
    // Same mission, the designer's own account — `findByMission...` is not
    // role-filtered, and the third row keeps the ordering non-trivial.
    newestBidId = await insertBid({
      missionId: bridgeId,
      pilotId: designerId,
      amount: "1500.00",
      status: "REJECTED",
      createdAt: new Date("2026-01-01T11:00:00Z"),
    });
    otherMissionBidId = await insertBid({
      missionId: towerId,
      pilotId,
      amount: "300.00",
      createdAt: new Date("2026-01-02T09:00:00Z"),
    });
    hiddenMissionBidId = await insertBid({
      missionId: hiddenId,
      pilotId,
      amount: "50.00",
      createdAt: new Date("2026-01-03T09:00:00Z"),
    });
  });

  afterAll(async () => {
    if (insertedMissionIds.length > 0) {
      // `fk_bid_mission ON DELETE CASCADE` would take the bids anyway; they go
      // explicitly so a bid on a mission this suite did not create (there are
      // none today) could never be orphaned by a future edit.
      if (insertedBidIds.length > 0) {
        await getDb().delete(bid).where(inArray(bid.id, insertedBidIds));
      }
      await getDb().delete(mission).where(inArray(mission.id, insertedMissionIds));
    }
    if (insertedUserIds.length > 0) {
      // `fk_bid_pilot` and `fk_mission_user` do not cascade, so both of the
      // above had to go first.
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  describe("findById", () => {
    it("resolves the mission and pilot names in the same statement the bid comes from", async () => {
      const found = await queries.findById(oldestBidId);

      // `BidMapper` reads these two off the JPA relations; the join is what
      // keeps that from being an N+1 of mission/user lookups here.
      expect(found).toMatchObject({
        id: oldestBidId,
        missionId: bridgeId,
        pilotId,
        message: "Two-day photogrammetry pass",
        status: "PENDING",
        mission: { id: bridgeId, name: `Bridge survey ${runId}` },
        pilot: { id: pilotId, username: "bid-queries-pilot" },
      });
      // `numeric(12, 2)` arrives as decimal text and is narrowed exactly once,
      // at this boundary — no consumer ever sees the string.
      expect(found?.amount).toBe(1200);
      expect(typeof found?.amount).toBe("number");
      expect(found?.createdAt).toBeInstanceOf(Date);
    });

    it("selects no password hash and no flight plan into a bid row", async () => {
      const found = await queries.findById(oldestBidId);

      // The joins take `users.id/username` and `mission.id/name` only: a bid
      // list must never carry a credential column, nor a mission's two `jsonb`
      // columns once per bid.
      expect(Object.keys(found?.pilot ?? {}).sort()).toEqual(["id", "username"]);
      expect(Object.keys(found?.mission ?? {}).sort()).toEqual(["id", "name"]);
    });

    it("answers undefined for an id that does not exist", async () => {
      expect(await queries.findById(999_999_999)).toBeUndefined();
    });
  });

  describe("findByMissionAndPilot", () => {
    it("returns the single bid the pair can have, and undefined when there is none", async () => {
      // Singular by constraint, not by convention: `bid_mission_pilot_unique`
      // is what makes one row the only possible answer.
      const found = await queries.findByMissionAndPilot(bridgeId, pilotId);
      expect(found?.id).toBe(oldestBidId);

      const otherMission = await queries.findByMissionAndPilot(towerId, otherPilotId);
      expect(otherMission).toBeUndefined();
    });
  });

  describe("findByMissionOrderByCreatedAtDesc", () => {
    it("returns every bid on that mission, newest first, and nothing from another mission", async () => {
      const found = await queries.findByMissionOrderByCreatedAtDesc(bridgeId);

      expect(found.map((b) => b.id)).toEqual([newestBidId, middleBidId, oldestBidId]);
      expect(found.map((b) => b.id)).not.toContain(otherMissionBidId);
      // Whatever their status: the designer's list shows decided bids too.
      expect(found.map((b) => b.status)).toEqual(["REJECTED", "PENDING", "PENDING"]);
      // Each row carries its own pilot's name off the join.
      expect(found.map((b) => b.pilot.username)).toEqual([
        "bid-queries-designer",
        "bid-queries-other-pilot",
        "bid-queries-pilot",
      ]);
    });

    it("returns the empty list for a mission nobody has bid on", async () => {
      const empty = await insertMission({ name: `Unbid ${runId}` });

      expect(await queries.findByMissionOrderByCreatedAtDesc(empty)).toEqual([]);
    });
  });

  describe("findByPilotOrderByCreatedAtDesc", () => {
    it("returns that pilot's bids across missions, newest first, with each mission's name", async () => {
      const found = await queries.findByPilotOrderByCreatedAtDesc(pilotId);

      expect(found.map((b) => b.id)).toEqual([hiddenMissionBidId, otherMissionBidId, oldestBidId]);
      expect(found.map((b) => b.mission.name)).toEqual([
        `Hidden job ${runId}`,
        `Tower inspection ${runId}`,
        `Bridge survey ${runId}`,
      ]);
      // Nobody else's bids, whatever mission they are on.
      expect(found.every((b) => b.pilot.id === pilotId)).toBe(true);
    });

    it("keeps a bid on a hidden mission — the source applies no moderation filter here", async () => {
      const found = await queries.findByPilotOrderByCreatedAtDesc(pilotId);

      // `/my-bids` is the pilot's own history: a mission being moderated away
      // afterwards must not silently erase what they offered on it.
      expect(found.map((b) => b.id)).toContain(hiddenMissionBidId);
    });

    it("returns the empty list for a pilot who has never bid", async () => {
      const newcomer = await insertUser("newcomer", "PILOT");

      expect(await queries.findByPilotOrderByCreatedAtDesc(newcomer)).toEqual([]);
    });
  });

  describe("save", () => {
    it("inserts when the id is absent, stamps both timestamps, and returns the joined names", async () => {
      const newcomer = await insertUser("inserting", "PILOT");

      const saved = await queries.save({
        missionId: towerId,
        pilotId: newcomer,
        amount: 750,
        message: "Includes thermal",
        status: "PENDING",
      });
      insertedBidIds.push(saved.id);

      expect(saved.id).toEqual(expect.any(Number));
      expect(saved.amount).toBe(750);
      expect(saved.status).toBe("PENDING");
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.updatedAt).toBeInstanceOf(Date);
      // Re-read through the joins, not assembled from the write.
      expect(saved.mission).toEqual({ id: towerId, name: `Tower inspection ${runId}` });
      expect(saved.pilot).toEqual({ id: newcomer, username: "bid-queries-inserting" });
    });

    it("lets Postgres apply the column's scale to the amount, as the JDBC driver does for a BigDecimal", async () => {
      const newcomer = await insertUser("rounding", "PILOT");

      const saved = await queries.save({
        missionId: towerId,
        pilotId: newcomer,
        amount: 1234.567,
        message: null,
        status: "PENDING",
      });
      insertedBidIds.push(saved.id);

      // `numeric(12, 2)` — the value is rounded by the column, not by the app,
      // and comes back narrowed to a number rather than "1234.57".
      expect(saved.amount).toBe(1234.57);
      const [row] = await getDb().select().from(bid).where(eq(bid.id, saved.id));
      expect(row.amount).toBe("1234.57");
    });

    it("updates the existing row when the id is present — the upsert never adds a second bid", async () => {
      const newcomer = await insertUser("upserting", "PILOT");
      const first = await queries.save({
        missionId: bridgeId,
        pilotId: newcomer,
        amount: 900,
        message: "Initial offer",
        status: "PENDING",
      });
      insertedBidIds.push(first.id);

      // Exactly the shape `BidService.place` takes on a re-bid: the row it
      // found, carrying its id, with a new amount/message.
      const second = await queries.save({
        id: first.id,
        missionId: bridgeId,
        pilotId: newcomer,
        amount: 850,
        message: "Sharpened after the site visit",
        status: first.status,
      });

      expect(second.id).toBe(first.id);
      expect(second.amount).toBe(850);
      expect(second.message).toBe("Sharpened after the site visit");
      // `created_at` is `updatable = false` on the Java entity; only
      // `updated_at` moves.
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
      expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());

      // The point of the whole exercise: one row, not two.
      const rows = await getDb().select().from(bid).where(eq(bid.pilotId, newcomer));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.id);
    });

    it("is rejected by bid_mission_pilot_unique when a second bid is inserted for the same pair", async () => {
      const newcomer = await insertUser("racing", "PILOT");
      const first = await queries.save({
        missionId: bridgeId,
        pilotId: newcomer,
        amount: 400,
        message: null,
        status: "PENDING",
      });
      insertedBidIds.push(first.id);

      // The insert branch with no id is what two `place` calls racing past
      // `findByMissionAndPilot` would both reach. There is no `ON CONFLICT`
      // clause — the source has no equivalent — so the constraint rejects the
      // loser rather than a duplicate slipping through.
      const rejection = await queries
        .save({
          missionId: bridgeId,
          pilotId: newcomer,
          amount: 380,
          message: null,
          status: "PENDING",
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
        "bid_mission_pilot_unique",
      );

      expect(await getDb().select().from(bid).where(eq(bid.pilotId, newcomer))).toHaveLength(1);
    });

    it("fails loudly when the row it was told to merge no longer exists", async () => {
      const newcomer = await insertUser("ghost", "PILOT");
      const inserted = await queries.save({
        missionId: bridgeId,
        pilotId: newcomer,
        amount: 100,
        message: null,
        status: "PENDING",
      });
      await getDb().delete(bid).where(eq(bid.id, inserted.id));

      await expect(
        queries.save({ ...inserted, missionId: bridgeId, pilotId: newcomer }),
      ).rejects.toThrow(`Bid ${inserted.id} no longer exists`);
    });
  });

  describe("deleteBid", () => {
    it("removes the row, which is how a withdrawal is recorded", async () => {
      const newcomer = await insertUser("withdrawing", "PILOT");
      const doomed = await queries.save({
        missionId: bridgeId,
        pilotId: newcomer,
        amount: 660,
        message: null,
        status: "PENDING",
      });

      await queries.deleteBid({ id: doomed.id });

      // `BidService.withdraw` deletes rather than restatusing — which is why
      // `BidRepository.volume()` can say it counts live bids only, and why the
      // audit row is all that survives the bid.
      expect(await queries.findById(doomed.id)).toBeUndefined();
      expect(await getDb().select().from(bid).where(eq(bid.id, doomed.id))).toEqual([]);
      // The mission and the pilot are untouched: only the bid goes.
      expect(await getDb().select().from(mission).where(eq(mission.id, bridgeId))).toHaveLength(1);
      expect(await getDb().select().from(users).where(eq(users.id, newcomer))).toHaveLength(1);
    });

    it("frees the pilot to bid on that mission again", async () => {
      const newcomer = await insertUser("rebidding", "PILOT");
      const first = await queries.save({
        missionId: towerId,
        pilotId: newcomer,
        amount: 500,
        message: null,
        status: "PENDING",
      });
      await queries.deleteBid({ id: first.id });

      // The unique constraint is on live rows only, so a withdrawal really is
      // a clean slate rather than a permanent lockout.
      const second = await queries.save({
        missionId: towerId,
        pilotId: newcomer,
        amount: 450,
        message: null,
        status: "PENDING",
      });
      insertedBidIds.push(second.id);

      expect(second.id).not.toBe(first.id);
      expect(second.amount).toBe(450);
    });
  });

  describe("volume", () => {
    /**
     * `volume()` takes no filter — it is the platform's total by definition —
     * so these cases cannot be scoped to this run's rows the way every case
     * above is. They use the relative form `user.queries.test.ts` documents
     * for exactly this situation instead: a concurrently running live suite
     * can only *add* bids to the platform, never remove the rows this run
     * owns, so "at least what this run inserted" stays true whatever else the
     * database holds, while an exact equality would be a race.
     */
    async function ourBids(): Promise<{ count: number; total: number }> {
      // The oracle is deliberately computed in JS from the raw rows rather
      // than by a second `sum()`, so it cannot pass by reproducing the same
      // aggregate the function under test uses.
      const rows = await getDb()
        .select({ amount: bid.amount })
        .from(bid)
        .where(inArray(bid.missionId, insertedMissionIds));
      return {
        count: rows.length,
        total: rows.reduce((sum, row) => sum + Number(row.amount), 0),
      };
    }

    it("counts every live bid and adds the amounts up as a number, not decimal text", async () => {
      const platform = await queries.volume();
      const ours = await ourBids();

      expect(platform.count).toBeGreaterThanOrEqual(ours.count);
      expect(typeof platform.count).toBe("number");
      // `sum(numeric)` comes back from postgres.js as decimal text; the DAO
      // narrows it exactly once, so a consumer never sees "12345.50". The
      // cent of slack absorbs the float error of the JS-side oracle only —
      // `platform.totalAmount` itself is the database's exact sum.
      expect(platform.totalAmount).toBeGreaterThan(ours.total - 0.01);
      expect(typeof platform.totalAmount).toBe("number");
      expect(Number.isNaN(platform.totalAmount)).toBe(false);
    });

    it("keeps the column's two-decimal scale in the total", async () => {
      const scaler = await insertUser("volume-scale", "PILOT");
      const saved = await queries.save({
        missionId: towerId,
        pilotId: scaler,
        amount: 10.555,
        message: null,
        status: "PENDING",
      });
      insertedBidIds.push(saved.id);

      const platform = await queries.volume();
      const ours = await ourBids();

      // Postgres rounded the new amount to the column's scale on the way in
      // (`numeric(12, 2)`), so it contributes 10.56 to the sum, not 10.555…
      expect(saved.amount).toBe(10.56);
      expect(platform.totalAmount).toBeGreaterThan(ours.total - 0.01);
      // …and every summand being exact to the cent makes the total exact to
      // the cent too, which a value that had been parsed as anything other
      // than the decimal text would not survive.
      expect(Math.round(platform.totalAmount * 100) / 100).toBe(platform.totalAmount);
    });

    it("answers zero rather than SQL NULL when there are no bids at all", async () => {
      // An aggregate with no `GROUP BY` returns its one row even over an empty
      // table, where `sum` is NULL — the `coalesce` is what turns that into 0.
      // Only a database with no bids can show it, which is the state
      // `baselineVolume` was read in (before this file inserted its fixture)
      // and which a clean local/CI database really is. On a developer database
      // that already carries bids the same guarantee is checked in the shape
      // that remains observable: still a number, never NULL or NaN.
      if (baselineVolume.count === 0) {
        expect(baselineVolume).toEqual({ count: 0, totalAmount: 0 });
      } else {
        expect(typeof baselineVolume.totalAmount).toBe("number");
        expect(Number.isNaN(baselineVolume.totalAmount)).toBe(false);
      }
    });
  });

  describe("topMissionsByBids", () => {
    /**
     * Its own fixture, tagged with a marker in every mission name: the query
     * is platform-wide, so the exact assertions filter the full list down to
     * the missions this block created, and the cap case asserts only what
     * holds whatever else the database contains.
     */
    const marker = `top-${runId}`;

    /** Three bids — the busiest mission this run creates. */
    let topA: number;
    /** Two bids. */
    let topB: number;
    /** Two bids as well, and moderated away — it must still be listed. */
    let topHidden: number;
    /** One bid. */
    let topC: number;

    function oursOnly(rows: Awaited<ReturnType<typeof queries.topMissionsByBids>>) {
      return rows.filter((row) => row.name?.includes(marker));
    }

    beforeAll(async () => {
      const first = await insertUser("top-first", "PILOT");
      const second = await insertUser("top-second", "PILOT");
      const third = await insertUser("top-third", "PILOT");

      topA = await insertMission({ name: `Top A ${marker}` });
      topB = await insertMission({ name: `Top B ${marker}` });
      topC = await insertMission({ name: `Top C ${marker}` });
      // Bid on by nobody — it must never appear.
      await insertMission({ name: `Top D ${marker}` });
      topHidden = await insertMission({ name: `Top hidden ${marker}`, moderation: "HIDDEN" });

      const at = new Date("2026-02-01T09:00:00Z");
      const fixture: ReadonlyArray<readonly [number, readonly number[]]> = [
        [topA, [first, second, third]],
        [topB, [first, second]],
        [topHidden, [first, second]],
        [topC, [first]],
      ];
      for (const [missionId, pilots] of fixture) {
        for (const pilot of pilots) {
          // One bid per pilot per mission — more would hit
          // `bid_mission_pilot_unique`, which is what makes each mission's
          // count here equal to its number of distinct bidders.
          await insertBid({ missionId, pilotId: pilot, amount: "100.00", createdAt: at });
        }
      }
    });

    it("ranks missions by their live bid count, busiest first", async () => {
      // A limit far above the number of missions any suite creates, so this
      // is the whole ranking and the filter below is a subsequence of it —
      // order preserved.
      const ranked = oursOnly(await queries.topMissionsByBids(1_000));

      expect(ranked).toEqual([
        { name: `Top A ${marker}`, total: 3 },
        // `Top hidden` and `Top B` are tied at two bids. The source leaves
        // ties unordered; this port breaks them by `mission.id DESC`, and the
        // hidden mission was inserted last, so it sorts first.
        { name: `Top hidden ${marker}`, total: 2 },
        { name: `Top B ${marker}`, total: 2 },
        { name: `Top C ${marker}`, total: 1 },
      ]);
      expect(typeof ranked[0].total).toBe("number");
    });

    it("leaves out a mission nobody has bid on", async () => {
      const ranked = oursOnly(await queries.topMissionsByBids(1_000));

      // Zero-bid missions are absent rather than present as zero: the count
      // is over `bid` rows, and the source's javadoc says so in as many words.
      expect(ranked.map((row) => row.name)).not.toContain(`Top D ${marker}`);
    });

    it("keeps a hidden mission in the chart — the source applies no moderation filter", async () => {
      const ranked = oursOnly(await queries.topMissionsByBids(1_000));

      // The overview is admin-only and its status counts include moderated
      // missions, so the chart beside them counts the same population.
      expect(ranked.map((row) => row.name)).toContain(`Top hidden ${marker}`);
    });

    it("returns no more rows than the limit, and the busiest ones", async () => {
      const capped = await queries.topMissionsByBids(2);

      // At least three missions carry bids (this block just made them), so a
      // limit of two is really cutting the list off rather than exhausting it.
      expect(capped).toHaveLength(2);
      expect(capped[0].total).toBeGreaterThanOrEqual(capped[1].total);
      // Whatever else the database holds, the busiest mission on the platform
      // has at least as many bids as `Top A`'s three — which is exactly what
      // "capped at the top of a descending order" has to mean.
      expect(capped[0].total).toBeGreaterThanOrEqual(3);
    });
  });
});

describe.skipIf(hasDb)("bid.queries.ts (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
