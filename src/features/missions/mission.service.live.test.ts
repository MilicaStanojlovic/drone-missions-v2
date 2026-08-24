import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import type { BidWrite } from "@/features/bids/bid.queries";

/**
 * Live-DB suite for the **atomicity** of `MissionService.cancel` — the half of
 * that method `mission.service.test.ts` structurally cannot prove.
 *
 * That suite stubs `@/db/client` with a `transaction()` that merely runs its
 * callback, so it can show the mission write and the bid rejections are
 * threaded onto one handle but never that a failure between them leaves the
 * database untouched. Whether the port really is atomic is a property of a
 * *real* Postgres transaction, so it is checked here — the same live-DB shape
 * `mission.queries.test.ts` uses, and the counterpart of
 * `src/features/bids/bid.service.live.test.ts`, which does this for `accept`.
 *
 * ## The injected failing step
 * Every write `cancel` makes is valid by construction (that is what the guards
 * before it are for), so no arrangement of real rows can make the second
 * statement fail. The failure is therefore *injected*: the bid query module is
 * wrapped so a rejection still performs its real write and then raises a
 * genuine Postgres error (`select 1 / 0`) **on the service's own transaction
 * handle** — aborting the transaction inside the database, the way a
 * constraint violation or a lost connection would, and forcing even the write
 * that had just succeeded to disappear for the assertions to pass.
 *
 * The wrapper is pass-through until a case arms it (`afterEach` disarms it
 * again), so the fixture writes go through the unmodified query module.
 *
 * The backend has no counterpart to mirror: `@Transactional` is applied by a
 * Spring proxy no unit test builds, and `MissionServiceTest` has no lifecycle
 * cases at all. Each case names the `MissionService.cancel` rule it pins.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../business/service/mission/MissionService.java (`cancel`, `@Transactional`)
 */

/**
 * Failure hook the mocked bid query module consults on every `save`. Hoisted
 * (`vi.hoisted`) because `vi.mock`'s factory is lifted above the imports and
 * would otherwise read this binding before it exists.
 */
const inject = vi.hoisted(() => ({
  afterBidSave: null as null | ((input: BidWrite, tx?: DbHandle) => Promise<void>),
}));

vi.mock("@/features/bids/bid.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/bids/bid.queries")>();
  return {
    ...actual,
    save: async (input: BidWrite, tx?: DbHandle) => {
      const saved = await actual.save(input, tx);
      await inject.afterBidSave?.(input, tx);
      return saved;
    },
  };
});

// `vi.mock` above is hoisted by Vitest, so these static imports already resolve
// against the wrapped bid query module.
import { closeDb, getDb } from "@/db/client";
import { auditLog, bid, mission, notification, users } from "@/db/schema";
import * as bidQueries from "@/features/bids/bid.queries";
import { getMissionDao } from "@/features/missions/mission.cache";
import * as missionQueries from "@/features/missions/mission.queries";
import { cancel } from "@/features/missions/mission.service";

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

describe.runIf(hasDb)("mission.service.ts cancel — transaction rollback (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();

  const insertedUserIds: number[] = [];
  const insertedMissionIds: number[] = [];

  let designerId: number;
  let awardedPilotId: number;
  let otherPilotId: number;

  async function insertUser(label: string, role: "DESIGNER" | "PILOT"): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `cancel-rollback-${label}`,
        email: `cancel-rollback-${runId}-${label}@example.com`,
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

  /** An AWARDED mission carrying the winner's ACCEPTED bid and one still-PENDING rival. */
  async function seedAwardedMission() {
    const target = await missionQueries.save({
      name: `Cancel rollback ${runId}`,
      description: `Cancel-rollback fixture ${runId}`,
      status: "AWARDED",
      moderation: "VISIBLE",
      userId: designerId,
      awardedPilotId,
      startTime: null,
      endTime: null,
      location: "Novi Sad",
      biddingDeadline: null,
      waypoints: null,
      geofence: null,
    });
    insertedMissionIds.push(target.id);
    const accepted = await bidQueries.save({
      missionId: target.id,
      pilotId: awardedPilotId,
      amount: 900,
      message: null,
      status: "ACCEPTED",
    });
    const pending = await bidQueries.save({
      missionId: target.id,
      pilotId: otherPilotId,
      amount: 950,
      message: null,
      status: "PENDING",
    });
    // Read the mission once so the caching DAO holds a pre-cancellation
    // snapshot: the rolled-back write must not leave a CANCELLED copy either.
    await getMissionDao().findById(target.id);
    return { target, accepted, pending };
  }

  /**
   * Everything `cancel` would have written, asserted absent: the mission's own
   * status, the bid rejections, the post-commit notification and audit entry,
   * and any cached copy of the mission.
   */
  async function expectNothingChanged(
    targetId: number,
    acceptedId: number,
    pendingId: number,
  ): Promise<void> {
    const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, targetId));
    expect(missionRow.status).toBe("AWARDED");
    expect(missionRow.awardedPilotId).toBe(awardedPilotId);

    const rows = await getDb().select().from(bid).where(eq(bid.missionId, targetId));
    // A mission left CANCELLED beside an ACCEPTED bid — or the reverse — is
    // exactly the state this transaction exists to prevent.
    expect(rows.find((row) => row.id === acceptedId)?.status).toBe("ACCEPTED");
    expect(rows.find((row) => row.id === pendingId)?.status).toBe("PENDING");

    // The notification and the audit entry are raised *after* the commit (the
    // divergence `cancel`'s docblock documents), so a failed transaction must
    // leave none of them — the failure surfaces to the caller instead.
    expect(
      await getDb().select().from(notification).where(eq(notification.missionId, targetId)),
    ).toEqual([]);
    expect(
      await getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetType, "MISSION"), eq(auditLog.targetId, targetId))),
    ).toEqual([]);

    // And nothing stale survives in front of the database: the very next read
    // still reports the mission as awarded.
    expect((await getMissionDao().findById(targetId))?.status).toBe("AWARDED");
  }

  beforeAll(async () => {
    designerId = await insertUser("designer", "DESIGNER");
    awardedPilotId = await insertUser("winner", "PILOT");
    otherPilotId = await insertUser("other", "PILOT");
  });

  afterEach(() => {
    inject.afterBidSave = null;
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

  it("rolls the cancellation back when rejecting an outstanding bid fails", async () => {
    const { target, accepted, pending } = await seedAwardedMission();
    // The mission is already written CANCELLED by the time the first rejection
    // fires, so it has to be undone along with the rejection itself.
    inject.afterBidSave = async (input, tx) => {
      expect(input.status).toBe("REJECTED");
      await failOnTheOpenTransaction(tx);
    };

    await expectInjectedFailure(cancel(target.id, designerId));

    await expectNothingChanged(target.id, accepted.id, pending.id);
  });

  it("still cancels normally once the injected failure is gone", async () => {
    // The harness is only as trustworthy as its off state: with no hook armed
    // the very same fixture commits, so the case above really does measure the
    // rollback rather than a broken cancel path.
    const { target, accepted, pending } = await seedAwardedMission();

    await cancel(target.id, designerId);

    const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, target.id));
    expect(missionRow.status).toBe("CANCELLED");
    const rows = await getDb().select().from(bid).where(eq(bid.missionId, target.id));
    expect(rows.find((row) => row.id === accepted.id)?.status).toBe("REJECTED");
    expect(rows.find((row) => row.id === pending.id)?.status).toBe("REJECTED");
    // Only the awarded pilot is told, and the cancellation is audited once.
    const notes = await getDb()
      .select()
      .from(notification)
      .where(eq(notification.missionId, target.id));
    expect(notes.map((note) => note.userId)).toEqual([awardedPilotId]);
    expect(
      await getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetType, "MISSION"), eq(auditLog.targetId, target.id))),
    ).toHaveLength(1);
  });
});

describe.skipIf(hasDb)("mission.service.ts cancel — transaction rollback (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
