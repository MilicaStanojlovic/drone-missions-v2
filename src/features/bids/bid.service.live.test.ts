import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import type { BidWrite } from "./bid.queries";
import type { MissionWrite } from "@/features/missions/mission.types";

/**
 * Live-DB suite for the **atomicity** of `BidService.accept` — the one thing
 * `bid.service.test.ts` structurally cannot prove.
 *
 * That suite stubs `@/db/client` with a `transaction()` that merely runs its
 * callback, so it can show the three writes are threaded onto one handle but
 * never that a failure half-way through leaves the database untouched. Whether
 * the port really is atomic is a property of a *real* Postgres transaction, so
 * it is checked here, against the local database `MIGRATION_PLAN.md` §8 sets
 * up — the same live-DB shape `mission.queries.test.ts` uses.
 *
 * ## The injected failing step
 * A mid-transaction failure cannot be arranged from real data alone: every
 * write `accept` makes is valid by construction (that is the point of the
 * guards that precede it), so nothing in the row set can be prepared to make
 * the second or third statement fail. The failure is therefore *injected*: the
 * two query modules are wrapped so a chosen `save` still performs its real
 * write and then raises a genuine Postgres error (`select 1 / 0`) **on the
 * service's own transaction handle**. That is stronger than throwing a plain
 * `Error` would be: it aborts the transaction inside the database, the way a
 * constraint violation or a lost connection would, and it means even the
 * write that had just succeeded has to disappear for the assertions to pass.
 *
 * The wrappers are pass-through until a case arms them (`afterEach` disarms
 * them again), so the fixture writes go through the unmodified queries.
 *
 * The backend has no counterpart to mirror — `@Transactional` is applied by a
 * Spring proxy that its Mockito `BidServiceTest` never builds, which is why
 * the JUnit suite has no rollback case either. Each case below names the
 * `BidService.accept` rule it pins instead.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../business/service/bid/BidService.java (`accept`, `@Transactional`)
 */

/**
 * Failure hooks the mocked query modules consult on every `save`. Hoisted
 * (`vi.hoisted`) because `vi.mock`'s factories are lifted above the imports
 * and would otherwise read this binding before it exists.
 */
const inject = vi.hoisted(() => ({
  afterBidSave: null as null | ((input: BidWrite, tx?: DbHandle) => Promise<void>),
  afterMissionSave: null as null | ((input: MissionWrite, tx?: DbHandle) => Promise<void>),
}));

vi.mock("./bid.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bid.queries")>();
  return {
    ...actual,
    save: async (input: BidWrite, tx?: DbHandle) => {
      const saved = await actual.save(input, tx);
      await inject.afterBidSave?.(input, tx);
      return saved;
    },
  };
});

vi.mock("@/features/missions/mission.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/missions/mission.queries")>();
  return {
    ...actual,
    save: async (input: MissionWrite, tx?: DbHandle) => {
      const saved = await actual.save(input, tx);
      await inject.afterMissionSave?.(input, tx);
      return saved;
    },
  };
});

// `vi.mock` calls above are hoisted by Vitest, so these static imports already
// resolve against the wrapped query modules (including `mission.cache.ts`,
// which builds its uncached DAO out of `mission.queries`' exports).
import { closeDb, getDb } from "@/db/client";
import { auditLog, bid, mission, notification, users } from "@/db/schema";
import { getMissionDao } from "@/features/missions/mission.cache";
import * as missionQueries from "@/features/missions/mission.queries";
import * as bidQueries from "./bid.queries";
import { accept } from "./bid.service";

const hasDb = Boolean(process.env.DATABASE_URL);

/**
 * Raises a real Postgres error on the transaction the service opened, aborting
 * it from inside the database. Never returns.
 */
async function failOnTheOpenTransaction(tx: DbHandle | undefined): Promise<never> {
  // The service always passes its handle down; asserting it makes a future
  // regression that dropped the handle fail *here* rather than silently
  // aborting some other connection.
  expect(tx).toBeDefined();
  await (tx as unknown as { execute: (query: SQL) => Promise<unknown> }).execute(sql`select 1 / 0`);
  throw new Error("unreachable: the injected statement was expected to fail");
}

/**
 * Asserts a call failed with the *injected* statement rather than with some
 * other error that happened to abort it. Drizzle wraps driver errors, so the
 * outer message names the query and the `cause` carries Postgres's own
 * `division by zero` — checking both is what makes this a database-level
 * failure, not a thrown `Error` the service could have produced itself.
 */
async function expectInjectedFailure(call: Promise<unknown>): Promise<void> {
  const error = await call.then(
    () => {
      throw new Error("expected the injected failure to surface to the caller");
    },
    (thrown: unknown) => thrown,
  );
  expect(String(error)).toMatch(/select 1 \/ 0/);
  expect(String((error as { cause?: unknown }).cause)).toMatch(/division by zero/i);
}

describe.runIf(hasDb)("bid.service.ts accept — transaction rollback (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();

  const insertedUserIds: number[] = [];
  const insertedMissionIds: number[] = [];

  let designerId: number;
  let winnerPilotId: number;
  let loserPilotId: number;

  async function insertUser(label: string, role: "DESIGNER" | "PILOT"): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `accept-rollback-${label}`,
        email: `accept-rollback-${runId}-${label}@example.com`,
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
    return row.id;
  }

  /** A BIDDING mission owned by the designer, with one bid from each pilot. */
  async function seedAuction() {
    const target = await missionQueries.save({
      name: `Rollback ${runId}`,
      description: `Accept-rollback fixture ${runId}`,
      status: "BIDDING",
      moderation: "VISIBLE",
      userId: designerId,
      awardedPilotId: null,
      startTime: null,
      endTime: null,
      location: "Novi Sad",
      biddingDeadline: null,
      waypoints: null,
      geofence: null,
    });
    insertedMissionIds.push(target.id);
    const winner = await bidQueries.save({
      missionId: target.id,
      pilotId: winnerPilotId,
      amount: 1000,
      message: null,
      status: "PENDING",
    });
    const loser = await bidQueries.save({
      missionId: target.id,
      pilotId: loserPilotId,
      amount: 1100,
      message: null,
      status: "PENDING",
    });
    // Read the mission once so the caching DAO holds a pre-award snapshot: the
    // rolled-back write must not leave an AWARDED copy behind it either.
    await getMissionDao().findById(target.id);
    return { target, winner, loser };
  }

  /**
   * Everything `accept` would have written, asserted absent: the two bid rows,
   * the mission's award, the post-commit notifications and audit entry, and
   * any cached copy of the mission.
   */
  async function expectNothingChanged(
    targetId: number,
    winnerId: number,
    loserId: number,
  ): Promise<void> {
    const rows = await getDb().select().from(bid).where(eq(bid.missionId, targetId));
    expect(rows.find((row) => row.id === winnerId)?.status).toBe("PENDING");
    expect(rows.find((row) => row.id === loserId)?.status).toBe("PENDING");

    const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, targetId));
    expect(missionRow.status).toBe("BIDDING");
    expect(missionRow.awardedPilotId).toBeNull();

    // The notifications and the audit entry are raised *after* the commit (the
    // divergence `accept`'s docblock documents), so a failed transaction must
    // leave none of them — the failure surfaces to the caller instead.
    expect(
      await getDb().select().from(notification).where(eq(notification.missionId, targetId)),
    ).toEqual([]);
    expect(
      await getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetType, "BID"), inArray(auditLog.targetId, [winnerId, loserId]))),
    ).toEqual([]);

    // And nothing stale survives in front of the database: the very next read
    // still reports an un-awarded mission.
    expect((await getMissionDao().findById(targetId))?.status).toBe("BIDDING");
  }

  beforeAll(async () => {
    designerId = await insertUser("designer", "DESIGNER");
    winnerPilotId = await insertUser("winner", "PILOT");
    loserPilotId = await insertUser("loser", "PILOT");
  });

  afterEach(() => {
    inject.afterBidSave = null;
    inject.afterMissionSave = null;
  });

  afterAll(async () => {
    if (insertedMissionIds.length > 0) {
      // Bids first (`fk_bid_pilot` does not cascade), then the missions.
      await getDb().delete(bid).where(inArray(bid.missionId, insertedMissionIds));
      await getDb().delete(mission).where(inArray(mission.id, insertedMissionIds));
    }
    if (insertedUserIds.length > 0) {
      // Audit rows deliberately outlive their actor (see `audit_log`'s doc
      // comment in db/schema.ts), so the committed case's entry goes explicitly.
      await getDb().delete(auditLog).where(inArray(auditLog.actorId, insertedUserIds));
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  it("rolls both bid writes back when the mission award fails mid-transaction", async () => {
    const { target, winner, loser } = await seedAuction();
    // The last of the three writes: the winner is ACCEPTED and the loser
    // REJECTED by the time this fires, so both have to be undone.
    inject.afterMissionSave = async (input, tx) => {
      expect(input.status).toBe("AWARDED");
      await failOnTheOpenTransaction(tx);
    };

    await expectInjectedFailure(accept(winner.id, designerId));

    await expectNothingChanged(target.id, winner.id, loser.id);
  });

  it("rolls the winner's acceptance back when rejecting a loser fails", async () => {
    const { target, winner, loser } = await seedAuction();
    // The middle write. A winner left ACCEPTED on a mission that was never
    // awarded is exactly the unrecoverable state the transaction exists for.
    inject.afterBidSave = async (input, tx) => {
      if (input.status !== "REJECTED") {
        return;
      }
      await failOnTheOpenTransaction(tx);
    };

    await expectInjectedFailure(accept(winner.id, designerId));

    await expectNothingChanged(target.id, winner.id, loser.id);
  });

  it("still awards normally once the injected failure is gone", async () => {
    // The harness is only as trustworthy as its off state: with no hook armed
    // the very same fixture commits, so the two cases above really do measure
    // the rollback rather than a broken accept path.
    const { target, winner, loser } = await seedAuction();

    await accept(winner.id, designerId);

    const rows = await getDb().select().from(bid).where(eq(bid.missionId, target.id));
    expect(rows.find((row) => row.id === winner.id)?.status).toBe("ACCEPTED");
    expect(rows.find((row) => row.id === loser.id)?.status).toBe("REJECTED");
    const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, target.id));
    expect(missionRow.status).toBe("AWARDED");
    expect(missionRow.awardedPilotId).toBe(winnerPilotId);
  });
});

describe.skipIf(hasDb)("bid.service.ts accept — transaction rollback (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
