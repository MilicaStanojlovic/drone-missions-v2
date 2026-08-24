import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mission } from "@/features/missions/mission.types";
import {
  MissionAccessDeniedError,
  MissionNotFoundError,
} from "@/features/missions/server/mission.service";
import { UserNotFoundError } from "@/features/users/server/user.queries";
import { UserSuspendedError } from "@/features/users/server/user.service";
import type { User } from "@/features/users/user.types";
import type { Bid } from "@/features/bids/bid.types";

/**
 * Vitest suite for `bid.service.ts`.
 *
 * Mirrors every case of `BidServiceTest` one-for-one, keeping the Java method
 * names as the `it` titles so the two suites can be diffed:
 * `placeOnHiddenMissionReadsAsNotFound`,
 * `placeOnSuspendedDesignersMissionReadsAsNotFound`,
 * `placeBySuspendedPilotRejected`, `placingANewBidRecordsThePilot`,
 * `raisingAnExistingPendingBidRecordsItAsUpdated`,
 * `withdrawingAPendingBidRecordsThePilot`, `acceptingABidRecordsExactlyOnce`
 * and `acceptFrozenWhilePilotSuspended`.
 *
 * The Java suite's own header calls it "moderation enforcement on bidding", so
 * it stops at the rules it was written for. The remaining `BidService`
 * behaviour — the biddable-status and deadline conflicts, the PUBLISHED ->
 * BIDDING flip, the new-bid email, `listForMission`'s owner/other split,
 * `myBids`, and `withdraw`'s two rejections — lives entirely in this module in
 * this port (the route handlers are thin), so it is pinned in the extra
 * `describe`s below rather than left to a controller test. The same applies to
 * `accept`: the Java suite covers only its audit entry and the suspended-pilot
 * freeze, so each of its five other guards, the atomic write set and the
 * winner/loser fan-out get a case here.
 *
 * Mocking mirrors the Java test's collaborators: the bid DAO, the mission DAO,
 * the user lookup, the notification service and the mail port are stubbed,
 * while `audit.ts` is only partially mocked — `record()` (the DB write) is a
 * spy and the real `bidPlaced`/`bidWithdrawn`/`bidAccepted` factories run, so
 * a captured entry proves the service audits the exact shape, including the
 * "(updated)" suffix the Java assertions look for. `@/db/client` is stubbed
 * too, with a `transaction()` that just runs its callback on a sentinel
 * handle — the Java test needs no equivalent because `@Transactional` is
 * applied by a proxy that a plain Mockito unit test never builds. That stub is
 * also this suite's one blind spot: it can prove the writes are threaded onto
 * a single handle, but not that a failure part-way through leaves the database
 * unchanged, which only a real transaction can show. `bid.service.live.test.ts`
 * covers that by injecting a failing step into an open transaction over real
 * rows; the case below pins the half that lives above the database (nothing
 * after the commit runs).
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/bid/BidServiceTest.java
 * - drone-missions-backend/.../business/service/bid/BidService.java
 */

const queriesMock = {
  findById: vi.fn(),
  findByMissionAndPilot: vi.fn(),
  findByMissionAndStatus: vi.fn(),
  findByMissionOrderByCreatedAtDesc: vi.fn(),
  findByPilotOrderByCreatedAtDesc: vi.fn(),
  save: vi.fn(),
  deleteBid: vi.fn(),
};
vi.mock("@/features/bids/server/bid.queries", () => ({
  findById: (...args: unknown[]) => queriesMock.findById(...args),
  findByMissionAndPilot: (...args: unknown[]) => queriesMock.findByMissionAndPilot(...args),
  findByMissionAndStatus: (...args: unknown[]) => queriesMock.findByMissionAndStatus(...args),
  findByMissionOrderByCreatedAtDesc: (...args: unknown[]) =>
    queriesMock.findByMissionOrderByCreatedAtDesc(...args),
  findByPilotOrderByCreatedAtDesc: (...args: unknown[]) =>
    queriesMock.findByPilotOrderByCreatedAtDesc(...args),
  save: (...args: unknown[]) => queriesMock.save(...args),
  deleteBid: (...args: unknown[]) => queriesMock.deleteBid(...args),
}));

const daoMock = {
  findById: vi.fn(),
  findFresh: vi.fn(),
  findOpen: vi.fn(),
  findByUserId: vi.fn(),
  findByAwardedPilotId: vi.fn(),
  invalidateLists: vi.fn(),
  invalidate: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};
vi.mock("@/features/missions/server/mission.cache", () => ({ getMissionDao: () => daoMock }));

/**
 * The stand-in for the handle Drizzle passes a `db.transaction` callback. The
 * service only ever forwards it to the query layer, so an opaque sentinel is
 * enough — and it is what lets the assertions below prove each write really
 * ran on the transaction rather than on the pool.
 */
const txHandle = { __transaction: true };
const transactionMock = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(txHandle));
vi.mock("@/db/client", () => ({
  getDb: () => ({ transaction: (run: (tx: unknown) => Promise<unknown>) => transactionMock(run) }),
}));

const findUserByIdMock = vi.fn();
const findUserByIdOrUndefinedMock = vi.fn();
vi.mock("@/features/users/server/user.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/users/server/user.queries")>();
  return {
    ...actual,
    findById: (...args: unknown[]) => findUserByIdMock(...args),
    findByIdOrUndefined: (...args: unknown[]) => findUserByIdOrUndefinedMock(...args),
  };
});

const createNotificationMock = vi.fn();
vi.mock("@/features/notifications/server/notification.service", () => ({
  create: (...args: unknown[]) => createNotificationMock(...args),
}));

const sendNewBidMock = vi.fn();
const sendBidDecisionMock = vi.fn();
vi.mock("@/lib/email/email.service", () => ({
  emailService: {
    sendNewBid: (...args: unknown[]) => sendNewBidMock(...args),
    sendBidDecision: (...args: unknown[]) => sendBidDecisionMock(...args),
    sendMissionOverdue: vi.fn(),
    sendMissionCancelled: vi.fn(),
  },
}));

const recordMock = vi.fn();
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, record: (...args: unknown[]) => recordMock(...args) };
});

// `vi.mock` calls above are hoisted by Vitest, so these static imports
// already resolve against the mocked modules.
import {
  accept,
  BidConflictError,
  BidNotFoundError,
  listForMission,
  myBids,
  place,
  withdraw,
} from "@/features/bids/server/bid.service";

/** The Java test's `user(id, suspended)` helper, with the columns this port has. */
function fakeUser(id: number, suspended: boolean, overrides: Partial<User> = {}): User {
  return {
    id,
    username: `user${id}`,
    email: `user${id}@example.com`,
    passwordHash: "hash",
    role: "PILOT",
    suspended,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * The Java test's `mission(moderation, designer)` helper: id 1, PUBLISHED, no
 * bidding deadline (so the deadline rule is out of the way unless a case opts
 * into it).
 */
function fakeMission(overrides: Partial<Mission> = {}): Mission {
  // `in`, not `??`: an explicit `designer: null` override (the ownerless
  // mission case) must survive rather than fall back to the default designer.
  const designer: User | null =
    "designer" in overrides
      ? (overrides.designer ?? null)
      : fakeUser(7, false, { role: "DESIGNER" });
  return {
    id: 1,
    name: "Orchard survey",
    description: null,
    status: "PUBLISHED",
    moderation: "VISIBLE",
    userId: designer === null ? null : designer.id,
    awardedPilotId: null,
    startTime: null,
    endTime: null,
    location: "Novi Sad",
    biddingDeadline: null,
    waypoints: null,
    geofence: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
    designer,
  };
}

/** A saved bid as the DAO hands it back — relations resolved by the join. */
function fakeBid(overrides: Partial<Bid> = {}): Bid {
  return {
    id: 3,
    missionId: 1,
    pilotId: 5,
    amount: 10,
    message: null,
    status: "PENDING",
    createdAt: new Date("2026-04-02T00:00:00Z"),
    updatedAt: new Date("2026-04-02T00:00:00Z"),
    mission: { id: 1, name: "Orchard survey" },
    pilot: { id: 5, username: "user5" },
    ...overrides,
  };
}

/**
 * The Java accept cases' fixture, in one place: bid 3 from pilot 5 wins over
 * bid 4 from pilot 6 on mission 1, owned by designer 7 and still PUBLISHED.
 *
 * The still-pending lookup returns `[winner, loser]` exactly as the Java stub
 * does — including the winner, so the service's own id filter is what keeps it
 * out of the rejections rather than the stub's shape.
 */
function arrangeAccept(
  overrides: { winner?: Bid; loser?: Bid; mission?: Mission; pilot?: User } = {},
) {
  const winner =
    overrides.winner ??
    fakeBid({ id: 3, amount: 10, pilotId: 5, pilot: { id: 5, username: "user5" } });
  const loser =
    overrides.loser ??
    fakeBid({ id: 4, amount: 12, pilotId: 6, pilot: { id: 6, username: "user6" } });
  const mission = overrides.mission ?? fakeMission();
  const pilot = overrides.pilot ?? fakeUser(5, false);

  queriesMock.findById.mockResolvedValue(winner);
  daoMock.findFresh.mockResolvedValue(mission);
  findUserByIdMock.mockResolvedValue(pilot);
  findUserByIdOrUndefinedMock.mockImplementation(async (id: number) => fakeUser(id, false));
  queriesMock.findByMissionAndStatus.mockResolvedValue([winner, loser]);
  // `save` echoes the status back on the row it was handed, the way the real
  // query re-reads the written row.
  queriesMock.save.mockImplementation(async (write: { id: number; status: Bid["status"] }) => ({
    ...(write.id === loser.id ? loser : winner),
    status: write.status,
  }));
  daoMock.save.mockImplementation(async (input: Mission) => input);
  return { winner, loser, mission, pilot };
}

/** The single audit entry the service recorded — the Java test's `ArgumentCaptor`. */
function capturedEntry() {
  expect(recordMock).toHaveBeenCalledTimes(1);
  return recordMock.mock.calls[0][0];
}

/** `yyyy-MM-dd` `days` away from today in the local zone, like the service's own `today()`. */
function localDay(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

describe("bid.service.ts", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("place — the BidServiceTest cases", () => {
    it("placeOnHiddenMissionReadsAsNotFound", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ moderation: "HIDDEN" }));

      await expect(place(1, 5, 10, null)).rejects.toBeInstanceOf(MissionNotFoundError);
    });

    it("placeOnSuspendedDesignersMissionReadsAsNotFound", async () => {
      daoMock.findFresh.mockResolvedValue(
        fakeMission({ designer: fakeUser(7, true, { role: "DESIGNER" }) }),
      );

      await expect(place(1, 5, 10, null)).rejects.toBeInstanceOf(MissionNotFoundError);
    });

    it("placeBySuspendedPilotRejected", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission());
      findUserByIdMock.mockResolvedValue(fakeUser(5, true));

      await expect(place(1, 5, 10, null)).rejects.toBeInstanceOf(UserSuspendedError);
      expect(queriesMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("placingANewBidRecordsThePilot", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission());
      findUserByIdMock.mockResolvedValue(fakeUser(5, false));
      queriesMock.findByMissionAndPilot.mockResolvedValue(undefined);
      queriesMock.save.mockImplementation(async (write: { amount: number }) =>
        fakeBid({ id: 3, amount: write.amount }),
      );

      await place(1, 5, 10, null);

      const entry = capturedEntry();
      expect(entry.actorId).toBe(5);
      expect(entry.action).toBe("BID_PLACED");
      expect(entry.targetId).toBe(3);
      expect(entry.details).not.toContain("(updated)");
      // A brand-new bid goes to the DAO without an id (so `save()` inserts)
      // and as PENDING — the Java `new Bid()` branch.
      expect(queriesMock.save).toHaveBeenCalledTimes(1);
      expect(queriesMock.save.mock.calls[0][0]).toEqual({
        id: undefined,
        missionId: 1,
        pilotId: 5,
        amount: 10,
        message: null,
        status: "PENDING",
      });
    });

    it("raisingAnExistingPendingBidRecordsItAsUpdated", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission());
      findUserByIdMock.mockResolvedValue(fakeUser(5, false));
      queriesMock.findByMissionAndPilot.mockResolvedValue(fakeBid({ id: 3, amount: 10 }));
      queriesMock.save.mockImplementation(async (write: { amount: number }) =>
        fakeBid({ id: 3, amount: write.amount }),
      );

      await place(1, 5, 1, null);

      expect(capturedEntry().details).toContain("(updated)");
      // The existing row's id is what makes `save()` take its UPDATE branch.
      expect(queriesMock.save.mock.calls[0][0].id).toBe(3);
    });
  });

  describe("accept — the BidServiceTest cases", () => {
    it("acceptingABidRecordsExactlyOnce", async () => {
      const { winner } = arrangeAccept();

      await accept(3, 7);

      const entry = capturedEntry();
      expect(entry.actorId).toBe(7);
      expect(entry.action).toBe("BID_ACCEPTED");
      // The losing bids are a side effect of this one decision and are not
      // audited — "exactly once" is the whole point of the Java case.
      expect(entry.targetId).toBe(winner.id);
    });

    it("acceptFrozenWhilePilotSuspended", async () => {
      arrangeAccept({ pilot: fakeUser(5, true) });

      await expect(accept(3, 7)).rejects.toBeInstanceOf(BidConflictError);
      await expect(accept(3, 7)).rejects.toThrow("suspended");
      // Frozen, not rejected: nothing is written at all, so the bid is still
      // PENDING and becomes acceptable again once the pilot is reactivated.
      expect(queriesMock.save).not.toHaveBeenCalled();
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });
  });

  // --- Beyond the Java suite: accept's remaining guards and side effects ---

  describe("accept — guards", () => {
    it("reads a missing bid as not found", async () => {
      queriesMock.findById.mockResolvedValue(undefined);

      await expect(accept(3, 7)).rejects.toBeInstanceOf(BidNotFoundError);
      expect(daoMock.findFresh).not.toHaveBeenCalled();
    });

    it("reads a vanished mission as not found", async () => {
      arrangeAccept();
      daoMock.findFresh.mockResolvedValue(undefined);

      await expect(accept(3, 7)).rejects.toBeInstanceOf(MissionNotFoundError);
    });

    it("refuses a caller who does not own the mission", async () => {
      arrangeAccept();

      await expect(accept(3, 8)).rejects.toBeInstanceOf(MissionAccessDeniedError);
      expect(queriesMock.save).not.toHaveBeenCalled();
    });

    it("refuses an ownerless mission — nobody may award it", async () => {
      arrangeAccept({ mission: fakeMission({ designer: null, userId: null }) });

      await expect(accept(3, 7)).rejects.toBeInstanceOf(MissionAccessDeniedError);
    });

    it("refuses a mission that has already been awarded", async () => {
      arrangeAccept({ mission: fakeMission({ status: "AWARDED" }) });

      await expect(accept(3, 7)).rejects.toThrow("Mission 1 has already been awarded");
      await expect(accept(3, 7)).rejects.toBeInstanceOf(BidConflictError);
      expect(queriesMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("refuses a bid that has already been decided", async () => {
      arrangeAccept({ winner: fakeBid({ id: 3, status: "REJECTED" }) });

      await expect(accept(3, 7)).rejects.toThrow("Bid 3 has already been decided");
      await expect(accept(3, 7)).rejects.toBeInstanceOf(BidConflictError);
      expect(queriesMock.save).not.toHaveBeenCalled();
    });

    it("checks ownership before the conflicts — a stranger never learns the status", async () => {
      // Both would fail: the mission is awarded *and* the caller is not its
      // owner. The source checks ownership first, so this must be a 403.
      arrangeAccept({ mission: fakeMission({ status: "AWARDED" }) });

      await expect(accept(3, 8)).rejects.toBeInstanceOf(MissionAccessDeniedError);
    });

    it("loads the mission fresh, never from the cache — it is about to write it", async () => {
      arrangeAccept();

      await accept(3, 7);

      expect(daoMock.findFresh).toHaveBeenCalledWith(1);
      expect(daoMock.findById).not.toHaveBeenCalled();
    });
  });

  describe("accept — the atomic write set", () => {
    it("accepts the winner, rejects every other pending bid, awards the mission", async () => {
      const { winner, loser } = arrangeAccept();

      const returned = await accept(3, 7);

      expect(returned.status).toBe("ACCEPTED");
      expect(returned.id).toBe(winner.id);
      // Winner first, then the one loser — and no third write: the winner is
      // filtered out of the still-pending set by id.
      expect(queriesMock.save).toHaveBeenCalledTimes(2);
      expect(queriesMock.save.mock.calls[0][0]).toMatchObject({ id: 3, status: "ACCEPTED" });
      expect(queriesMock.save.mock.calls[1][0]).toMatchObject({ id: loser.id, status: "REJECTED" });
      expect(daoMock.save).toHaveBeenCalledTimes(1);
      expect(daoMock.save.mock.calls[0][0]).toMatchObject({
        id: 1,
        status: "AWARDED",
        awardedPilotId: 5,
      });
    });

    it("runs all three writes on one transaction handle", async () => {
      arrangeAccept();

      await accept(3, 7);

      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(queriesMock.save.mock.calls[0][1]).toBe(txHandle);
      expect(queriesMock.save.mock.calls[1][1]).toBe(txHandle);
      expect(queriesMock.findByMissionAndStatus).toHaveBeenCalledWith(1, "PENDING", txHandle);
      expect(daoMock.save.mock.calls[0][1]).toBe(txHandle);
    });

    it("evicts the mission again once the transaction has committed", async () => {
      arrangeAccept();

      await accept(3, 7);

      // The port of the source's `afterCompletion` re-eviction: a concurrent
      // reader may have re-cached the pre-award row while the write was open.
      expect(daoMock.invalidate).toHaveBeenCalledWith(1);
    });

    it("propagates a mid-transaction failure and runs none of the post-commit work", async () => {
      arrangeAccept();
      // The third write fails, after the winner and the loser have already
      // been written. What that rolls *back* is a property of a real Postgres
      // transaction and is pinned in `bid.service.live.test.ts`, where the
      // failure is injected into an open transaction over real rows; what a
      // stubbed `transaction()` can show is the other half — that everything
      // sequenced after the commit is skipped.
      daoMock.save.mockRejectedValue(new Error("mission write failed"));

      await expect(accept(3, 7)).rejects.toThrow("mission write failed");

      // No second eviction, no notifications, no emails, no audit entry: the
      // failure surfaces to the caller instead of an acceptance being
      // announced that the database never kept.
      expect(daoMock.invalidate).not.toHaveBeenCalled();
      expect(createNotificationMock).not.toHaveBeenCalled();
      expect(sendBidDecisionMock).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("leaves a bid that is no longer pending alone", async () => {
      // A bid decided between the caller's read and this transaction is simply
      // not in the still-pending set, so nothing rewrites it.
      const { loser } = arrangeAccept();
      queriesMock.findByMissionAndStatus.mockResolvedValue([]);

      await accept(3, 7);

      expect(queriesMock.save).toHaveBeenCalledTimes(1);
      expect(queriesMock.save.mock.calls[0][0].id).not.toBe(loser.id);
    });
  });

  describe("accept — notifications and emails", () => {
    it("notifies and emails the winner as accepted and each loser as rejected", async () => {
      arrangeAccept();

      await accept(3, 7);

      expect(createNotificationMock).toHaveBeenCalledTimes(2);
      expect(createNotificationMock.mock.calls[0][0]).toEqual({
        userId: 5,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: 'Your bid on "Orchard survey" was accepted — the mission is yours.',
        mission: { id: 1, name: "Orchard survey" },
      });
      expect(createNotificationMock.mock.calls[1][0]).toMatchObject({
        userId: 6,
        type: "BID_REJECTED",
      });

      expect(sendBidDecisionMock).toHaveBeenCalledTimes(2);
      const [winnerPilot, winnerMission, winnerAmount, winnerAccepted] =
        sendBidDecisionMock.mock.calls[0];
      expect(winnerPilot).toEqual({ email: "user5@example.com", username: "user5" });
      expect(winnerMission).toEqual({ id: 1, name: "Orchard survey", location: "Novi Sad" });
      expect(winnerAmount).toBe(10);
      expect(winnerAccepted).toBe(true);
      expect(sendBidDecisionMock.mock.calls[1][0]).toEqual({
        email: "user6@example.com",
        username: "user6",
      });
      expect(sendBidDecisionMock.mock.calls[1][3]).toBe(false);
    });

    it("still awards the mission when a pilot's account has vanished — no email", async () => {
      arrangeAccept();
      // `notifyDecision`'s lookup is the source's `.ifPresent`: no account, no
      // email, and the decision that was already written still stands.
      findUserByIdOrUndefinedMock.mockResolvedValue(undefined);

      await expect(accept(3, 7)).resolves.toMatchObject({ status: "ACCEPTED" });
      expect(sendBidDecisionMock).not.toHaveBeenCalled();
      expect(createNotificationMock).toHaveBeenCalledTimes(2);
      expect(recordMock).toHaveBeenCalledTimes(1);
    });

    it("notifies only after the writes, and audits last", async () => {
      arrangeAccept();
      const order: string[] = [];
      queriesMock.save.mockImplementation(async (write: { id: number; status: string }) => {
        order.push(`save:${write.status}`);
        return fakeBid({ id: write.id, status: write.status as Bid["status"] });
      });
      daoMock.save.mockImplementation(async () => {
        order.push("award");
      });
      createNotificationMock.mockImplementation(async () => {
        order.push("notify");
      });
      recordMock.mockImplementation(async () => {
        order.push("audit");
      });

      await accept(3, 7);

      expect(order).toEqual([
        "save:ACCEPTED",
        "save:REJECTED",
        "award",
        "notify",
        "notify",
        "audit",
      ]);
    });
  });

  describe("withdraw — the BidServiceTest case", () => {
    it("withdrawingAPendingBidRecordsThePilot", async () => {
      const bid = fakeBid({ id: 3, amount: 10 });
      queriesMock.findById.mockResolvedValue(bid);

      await withdraw(3, 5);

      expect(queriesMock.deleteBid).toHaveBeenCalledWith(bid);
      const entry = capturedEntry();
      expect(entry.action).toBe("BID_WITHDRAWN");
      expect(entry.actorId).toBe(5);
    });
  });

  // --- Beyond the Java suite: rules this port keeps in the service ---

  describe("place — mission openness", () => {
    it("rejects a mission that is not open for bidding", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ status: "AWARDED" }));
      findUserByIdMock.mockResolvedValue(fakeUser(5, false));

      await expect(place(1, 5, 10, null)).rejects.toThrow("Mission 1 is not open for bidding");
      await expect(place(1, 5, 10, null)).rejects.toBeInstanceOf(BidConflictError);
      expect(queriesMock.save).not.toHaveBeenCalled();
    });

    it("still accepts a bid on the deadline day itself", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ biddingDeadline: localDay(0) }));
      findUserByIdMock.mockResolvedValue(fakeUser(5, false));
      queriesMock.findByMissionAndPilot.mockResolvedValue(undefined);
      queriesMock.save.mockResolvedValue(fakeBid());

      await expect(place(1, 5, 10, null)).resolves.toBeDefined();
    });

    it("rejects a bid once the deadline has passed", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ biddingDeadline: localDay(-1) }));
      findUserByIdMock.mockResolvedValue(fakeUser(5, false));

      await expect(place(1, 5, 10, null)).rejects.toThrow(
        "The bidding deadline for mission 1 has passed",
      );
      expect(queriesMock.save).not.toHaveBeenCalled();
    });

    it("rejects an update to a bid that has already been decided", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ status: "BIDDING" }));
      findUserByIdMock.mockResolvedValue(fakeUser(5, false));
      queriesMock.findByMissionAndPilot.mockResolvedValue(fakeBid({ id: 3, status: "REJECTED" }));

      await expect(place(1, 5, 10, null)).rejects.toThrow(
        "Bid 3 has already been decided and cannot be changed",
      );
      expect(queriesMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("reads as not found when the mission does not exist at all", async () => {
      daoMock.findFresh.mockResolvedValue(undefined);

      await expect(place(1, 5, 10, null)).rejects.toBeInstanceOf(MissionNotFoundError);
    });

    it("propagates the user lookup's not-found error for an unknown pilot", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission());
      findUserByIdMock.mockRejectedValue(new UserNotFoundError(5));

      await expect(place(1, 5, 10, null)).rejects.toBeInstanceOf(UserNotFoundError);
    });
  });

  describe("place — side effects", () => {
    it("flips a PUBLISHED mission to BIDDING on the first bid", async () => {
      const mission = fakeMission({ status: "PUBLISHED" });
      daoMock.findFresh.mockResolvedValue(mission);
      findUserByIdMock.mockResolvedValue(fakeUser(5, false));
      queriesMock.findByMissionAndPilot.mockResolvedValue(undefined);
      queriesMock.save.mockResolvedValue(fakeBid());

      await place(1, 5, 10, null);

      expect(daoMock.save).toHaveBeenCalledTimes(1);
      expect(daoMock.save.mock.calls[0][0].status).toBe("BIDDING");
      expect(daoMock.save.mock.calls[0][0].id).toBe(1);
    });

    it("leaves a mission that is already BIDDING alone", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ status: "BIDDING" }));
      findUserByIdMock.mockResolvedValue(fakeUser(5, false));
      queriesMock.findByMissionAndPilot.mockResolvedValue(undefined);
      queriesMock.save.mockResolvedValue(fakeBid());

      await place(1, 5, 10, null);

      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("emails the designer about the new bid and records no notification", async () => {
      const designer = fakeUser(7, false, {
        role: "DESIGNER",
        username: "dana",
        email: "dana@example.com",
      });
      daoMock.findFresh.mockResolvedValue(fakeMission({ designer }));
      findUserByIdMock.mockResolvedValue(fakeUser(5, false, { username: "pat" }));
      queriesMock.findByMissionAndPilot.mockResolvedValue(undefined);
      queriesMock.save.mockResolvedValue(fakeBid());

      await place(1, 5, 250.5, "Can fly Tuesday");

      expect(sendNewBidMock).toHaveBeenCalledTimes(1);
      expect(sendNewBidMock.mock.calls[0][0]).toEqual({
        designer: { email: "dana@example.com", username: "dana" },
        mission: { id: 1, name: "Orchard survey", location: "Novi Sad" },
        pilotName: "pat",
        amount: 250.5,
        message: "Can fly Tuesday",
      });
      // The source creates no in-app notification on place — only the accept
      // flow (Phase 5) notifies — so the only recorded side effect is audit.
      expect(recordMock).toHaveBeenCalledTimes(1);
    });

    it("skips the email for an ownerless mission but still saves and audits", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ designer: null, userId: null }));
      findUserByIdMock.mockResolvedValue(fakeUser(5, false));
      queriesMock.findByMissionAndPilot.mockResolvedValue(undefined);
      queriesMock.save.mockResolvedValue(fakeBid());

      await place(1, 5, 10, null);

      expect(sendNewBidMock).not.toHaveBeenCalled();
      expect(queriesMock.save).toHaveBeenCalledTimes(1);
      expect(capturedEntry().action).toBe("BID_PLACED");
    });
  });

  describe("listForMission", () => {
    it("gives the owning designer every bid, newest first", async () => {
      daoMock.findById.mockResolvedValue(fakeMission({ userId: 7 }));
      const all = [fakeBid({ id: 4 }), fakeBid({ id: 3 })];
      queriesMock.findByMissionOrderByCreatedAtDesc.mockResolvedValue(all);

      await expect(listForMission(1, 7)).resolves.toBe(all);
      expect(queriesMock.findByMissionAndPilot).not.toHaveBeenCalled();
    });

    it("gives anyone else only their own bid", async () => {
      daoMock.findById.mockResolvedValue(fakeMission({ userId: 7 }));
      const own = fakeBid({ id: 3, pilotId: 5 });
      queriesMock.findByMissionAndPilot.mockResolvedValue(own);

      await expect(listForMission(1, 5)).resolves.toEqual([own]);
      expect(queriesMock.findByMissionOrderByCreatedAtDesc).not.toHaveBeenCalled();
    });

    it("gives a pilot who has not bid an empty list", async () => {
      daoMock.findById.mockResolvedValue(fakeMission({ userId: 7 }));
      queriesMock.findByMissionAndPilot.mockResolvedValue(undefined);

      await expect(listForMission(1, 5)).resolves.toEqual([]);
    });

    it("reads as not found when the mission does not exist", async () => {
      daoMock.findById.mockResolvedValue(undefined);

      await expect(listForMission(1, 5)).rejects.toBeInstanceOf(MissionNotFoundError);
    });

    it("uses the cached lookup, never findFresh — it never writes", async () => {
      daoMock.findById.mockResolvedValue(fakeMission({ userId: 7 }));
      queriesMock.findByMissionOrderByCreatedAtDesc.mockResolvedValue([]);

      await listForMission(1, 7);

      expect(daoMock.findById).toHaveBeenCalledWith(1);
      expect(daoMock.findFresh).not.toHaveBeenCalled();
    });
  });

  describe("myBids", () => {
    it("hands back the pilot's bids exactly as the DAO ordered them", async () => {
      const bids = [fakeBid({ id: 4 }), fakeBid({ id: 3 })];
      queriesMock.findByPilotOrderByCreatedAtDesc.mockResolvedValue(bids);

      await expect(myBids(5)).resolves.toBe(bids);
      expect(queriesMock.findByPilotOrderByCreatedAtDesc).toHaveBeenCalledWith(5);
    });
  });

  describe("withdraw", () => {
    it("reads someone else's bid as not found rather than forbidden", async () => {
      queriesMock.findById.mockResolvedValue(
        fakeBid({ id: 3, pilot: { id: 6, username: "other" } }),
      );

      await expect(withdraw(3, 5)).rejects.toBeInstanceOf(BidNotFoundError);
      expect(queriesMock.deleteBid).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("reads a missing bid as not found", async () => {
      queriesMock.findById.mockResolvedValue(undefined);

      await expect(withdraw(3, 5)).rejects.toBeInstanceOf(BidNotFoundError);
    });

    it("refuses to withdraw a bid that has already been decided", async () => {
      queriesMock.findById.mockResolvedValue(fakeBid({ id: 3, status: "ACCEPTED" }));

      await expect(withdraw(3, 5)).rejects.toThrow(
        "Bid 3 has already been decided and cannot be withdrawn",
      );
      expect(queriesMock.deleteBid).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("snapshots the amount and mission name into the audit entry it leaves behind", async () => {
      queriesMock.findById.mockResolvedValue(
        fakeBid({ id: 3, amount: 10, mission: { id: 1, name: "Orchard survey" } }),
      );

      await withdraw(3, 5);

      expect(capturedEntry()).toEqual({
        actorId: 5,
        actorRole: "PILOT",
        action: "BID_WITHDRAWN",
        targetType: "BID",
        targetId: 3,
        details: '10 on "Orchard survey"',
      });
    });
  });
});
