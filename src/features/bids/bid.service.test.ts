import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mission } from "@/features/missions/mission.types";
import { MissionNotFoundError } from "@/features/missions/mission.service";
import { UserNotFoundError } from "@/features/users/user.queries";
import { UserSuspendedError } from "@/features/users/user.service";
import type { User } from "@/features/users/user.types";
import type { Bid } from "./bid.types";

/**
 * Vitest suite for `bid.service.ts`.
 *
 * Mirrors the phase-3 cases of `BidServiceTest` one-for-one, keeping the Java
 * method names as the `it` titles so the two suites can be diffed:
 * `placeOnHiddenMissionReadsAsNotFound`,
 * `placeOnSuspendedDesignersMissionReadsAsNotFound`,
 * `placeBySuspendedPilotRejected`, `placingANewBidRecordsThePilot`,
 * `raisingAnExistingPendingBidRecordsItAsUpdated`,
 * `withdrawingAPendingBidRecordsThePilot`. Its last two cases
 * (`acceptingABidRecordsExactlyOnce`, `acceptFrozenWhilePilotSuspended`) are
 * skipped: `accept` is Phase 5 and has no port yet.
 *
 * The Java suite's own header calls it "moderation enforcement on bidding", so
 * it stops at the rules it was written for. The remaining `BidService`
 * behaviour — the biddable-status and deadline conflicts, the PUBLISHED ->
 * BIDDING flip, the new-bid email, `listForMission`'s owner/other split,
 * `myBids`, and `withdraw`'s two rejections — lives entirely in this module in
 * this port (the route handlers are thin), so it is pinned in the extra
 * `describe`s below rather than left to a controller test.
 *
 * Mocking mirrors the Java test's collaborators: the bid DAO, the mission DAO,
 * the user lookup and the mail port are stubbed, while `audit.ts` is only
 * partially mocked — `record()` (the DB write) is a spy and the real
 * `bidPlaced`/`bidWithdrawn` factories run, so a captured entry proves the
 * service audits the exact shape, including the "(updated)" suffix the Java
 * assertions look for.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/bid/BidServiceTest.java
 * - drone-missions-backend/.../business/service/bid/BidService.java
 */

const queriesMock = {
  findById: vi.fn(),
  findByMissionAndPilot: vi.fn(),
  findByMissionOrderByCreatedAtDesc: vi.fn(),
  findByPilotOrderByCreatedAtDesc: vi.fn(),
  save: vi.fn(),
  deleteBid: vi.fn(),
};
vi.mock("./bid.queries", () => ({
  findById: (...args: unknown[]) => queriesMock.findById(...args),
  findByMissionAndPilot: (...args: unknown[]) => queriesMock.findByMissionAndPilot(...args),
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
  invalidateLists: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};
vi.mock("@/features/missions/mission.cache", () => ({ getMissionDao: () => daoMock }));

const findUserByIdMock = vi.fn();
vi.mock("@/features/users/user.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/users/user.queries")>();
  return { ...actual, findById: (...args: unknown[]) => findUserByIdMock(...args) };
});

const sendNewBidMock = vi.fn();
vi.mock("@/lib/email/email.service", () => ({
  emailService: {
    sendNewBid: (...args: unknown[]) => sendNewBidMock(...args),
    sendBidDecision: vi.fn(),
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
  BidConflictError,
  BidNotFoundError,
  listForMission,
  myBids,
  place,
  withdraw,
} from "./bid.service";

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
