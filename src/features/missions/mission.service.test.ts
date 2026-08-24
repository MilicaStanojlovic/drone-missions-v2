import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bid } from "@/features/bids/bid.types";
import type { User } from "@/features/users/user.types";
import { UserSuspendedError } from "@/features/users/user.service";
import { UserNotFoundError } from "@/features/users/user.queries";
import type { Mission, MissionStatus } from "@/features/missions/mission.types";
import type { OpenMissionQuery } from "@/features/missions/mission.queries";

/**
 * Vitest suite for `mission.service.ts`.
 *
 * Mirrors the phase-2 cases of `MissionServiceTest` — the `findOpen`
 * normalisation ones, which pin what keeps case-different searches for the
 * same thing (e.g. "Novi Sad" vs. "novi sad") from becoming two distinct,
 * duplicate list-cache entries: `lowercasesAndTrimsLocationAndKeyword`,
 * `blankFiltersBecomeNull`, `nullFiltersStayNull`,
 * `searchesDifferingOnlyByCaseProduceAnEqualCacheKey`,
 * `statusesAreAlwaysPublishedAndBidding` — plus its sixth case,
 * `adminSearchBuildsALowercasePatternAndBlankMeansEverything`, mirrored in
 * Phase 7 along with `searchAll` itself.
 *
 * Phase 7 also mirrors the four moderation cases of
 * `MissionServiceModerationTest` — `hideMovesVisibleToHiddenAndRecordsTheAdmin`,
 * `hideRejectsAlreadyHidden`, `removeDeletesTheMissionAndRecordsTheAdmin`,
 * `removingAMissingMissionIsANotFound`. That suite's other five cases are
 * already covered above and are not duplicated: its three suspension cases
 * (`createRejectsSuspendedDesigner`, `startRejectsSuspendedPilot`,
 * `completeRejectsSuspendedPilot`) landed with `create` in Phase 2 and with
 * `start`/`complete` in Phase 5, and its two owner-delete cases
 * (`ownerDeleteRemovesAndRecordsTheDesigner`, `ownerDeleteByAnyoneElseIsDenied`)
 * with `deleteMission` in Phase 2. `unhide` has no Java case at all — the
 * mirror-image transition is pinned here anyway, since it is the other half of
 * the one state machine `hide` shares.
 *
 * The Java suite stops at `findOpen`, because that is the method issue #12
 * was about; the create/visibility/ownership rules it leaves to
 * `MissionControllerTest` are covered here too, since this port's route
 * handlers are thin and those rules live entirely in this module.
 *
 * The same applies to the Phase-5 lifecycle (`start`, `complete`, `cancel`,
 * `findAwardedTo`): the Java suite has no case for any of them, so the rules
 * pinned below come from `MissionService`'s own javadoc and code — one case
 * per guard, the happy path of each transition, and for `cancel` the atomic
 * bid rejection (PENDING *and* ACCEPTED) plus the awarded pilot's
 * notification and email. Two absences are asserted deliberately, because
 * both are behaviour: `start`/`complete` raise no notification and no email,
 * and **no read ever changes a status** — there is no lazy
 * AWARDED -> IN_PROGRESS promotion in the source, contrary to what the
 * migration plan claims (see the service module's header).
 *
 * The DAO is mocked the same way the Java test mocks `MissionDao` — so these
 * assertions are about the query this service *builds*, not about SQL — and
 * `audit.ts` is only partially mocked: `record()` (the DB write) is a spy
 * while the real `missionCreated`/`missionUpdated`/`missionDeleted` factories
 * run, so the captured entry proves the service audits the right shape.
 *
 * SOURCE: drone-missions-backend/.../business/service/mission/MissionServiceTest.java,
 * .../business/service/mission/MissionService.java
 */

const daoMock = {
  findById: vi.fn(),
  findFresh: vi.fn(),
  findOpen: vi.fn(),
  findByUserId: vi.fn(),
  findByAwardedPilotId: vi.fn(),
  searchAll: vi.fn(),
  invalidateLists: vi.fn(),
  invalidate: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};
vi.mock("@/features/missions/mission.cache", () => ({ getMissionDao: () => daoMock }));

/**
 * The stand-in for the handle Drizzle passes a `db.transaction` callback. The
 * service only ever forwards it to the query layer, so an opaque sentinel is
 * enough — and it is what lets the `cancel` assertions prove each write really
 * ran on the transaction rather than on the pool.
 *
 * It is also this suite's one blind spot: a stub cannot show that a failure
 * part-way through leaves the database unchanged, which only a real
 * transaction can. `mission.service.live.test.ts` covers that by injecting a
 * failing step into an open transaction over real rows; the case below pins
 * the half that lives above the database (nothing after the commit runs).
 */
const txHandle = { __transaction: true };
const transactionMock = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(txHandle));
vi.mock("@/db/client", () => ({
  getDb: () => ({ transaction: (run: (tx: unknown) => Promise<unknown>) => transactionMock(run) }),
}));

const findBidsMock = vi.fn();
const saveBidMock = vi.fn();
vi.mock("@/features/bids/bid.queries", () => ({
  findByMissionOrderByCreatedAtDesc: (...args: unknown[]) => findBidsMock(...args),
  save: (...args: unknown[]) => saveBidMock(...args),
}));

const createNotificationMock = vi.fn();
vi.mock("@/features/notifications/notification.service", () => ({
  create: (...args: unknown[]) => createNotificationMock(...args),
}));

const sendMissionCancelledMock = vi.fn();
vi.mock("@/lib/email/email.service", () => ({
  emailService: {
    sendNewBid: vi.fn(),
    sendBidDecision: vi.fn(),
    sendMissionOverdue: vi.fn(),
    sendMissionCancelled: (...args: unknown[]) => sendMissionCancelledMock(...args),
  },
}));

const findUserByIdMock = vi.fn();
const findUserByIdOrUndefinedMock = vi.fn();
vi.mock("@/features/users/user.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/users/user.queries")>();
  return {
    ...actual,
    findById: (...args: unknown[]) => findUserByIdMock(...args),
    findByIdOrUndefined: (...args: unknown[]) => findUserByIdOrUndefinedMock(...args),
  };
});

const recordMock = vi.fn();
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, record: (...args: unknown[]) => recordMock(...args) };
});

// `vi.mock` calls above are hoisted by Vitest, so these static imports
// already resolve against the mocked modules.
import {
  cancel,
  complete,
  create,
  deleteMission,
  findAwardedTo,
  findById,
  findOpen,
  findOwnedBy,
  hide,
  MissionAccessDeniedError,
  MissionConflictError,
  MissionNotFoundError,
  remove,
  searchAll,
  start,
  unhide,
  update,
  type MissionDraft,
} from "@/features/missions/mission.service";

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 7,
    username: "dana",
    email: "dana@example.com",
    passwordHash: "hash",
    role: "DESIGNER",
    suspended: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 4,
    name: "Orchard survey",
    description: "Fly the north rows",
    status: "PUBLISHED" as MissionStatus,
    moderation: "VISIBLE",
    userId: 7,
    awardedPilotId: null,
    startTime: new Date("2026-05-01T08:00:00Z"),
    endTime: new Date("2026-05-01T10:00:00Z"),
    location: "Novi Sad",
    biddingDeadline: "2026-04-25",
    waypoints: [
      { lat: 45.25, lng: 19.83, altitude: 40, action: "PHOTO" },
      { lat: 45.26, lng: 19.84, altitude: 40, action: "PHOTO" },
    ],
    geofence: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    designer: fakeUser(),
    ...overrides,
  };
}

/**
 * A bid on mission 4 as the bid query layer hands it back — relations
 * resolved by the join. Only `cancel` reads these.
 */
function fakeBid(overrides: Partial<Bid> = {}): Bid {
  return {
    id: 11,
    missionId: 4,
    pilotId: 5,
    amount: 250,
    message: null,
    status: "PENDING",
    createdAt: new Date("2026-04-02T00:00:00Z"),
    updatedAt: new Date("2026-04-02T00:00:00Z"),
    mission: { id: 4, name: "Orchard survey" },
    pilot: { id: overrides.pilotId ?? 5, username: "pia" },
    ...overrides,
  };
}

const draft: MissionDraft = {
  name: "Orchard survey",
  description: "Fly the north rows",
  status: "PUBLISHED",
  startTime: new Date("2026-05-01T08:00:00Z"),
  endTime: new Date("2026-05-01T10:00:00Z"),
  location: "Novi Sad",
  biddingDeadline: "2026-04-25",
  waypoints: [
    { lat: 45.25, lng: 19.83, altitude: 40, action: "PHOTO" },
    { lat: 45.26, lng: 19.84, altitude: 40, action: "PHOTO" },
  ],
  geofence: null,
};

/** The Java test's `capturedQuery()` — the last `OpenMissionQuery` built. */
function capturedQuery(): OpenMissionQuery {
  expect(daoMock.findOpen).toHaveBeenCalled();
  const calls = daoMock.findOpen.mock.calls;
  return calls[calls.length - 1][0] as OpenMissionQuery;
}

describe("mission.service.ts", () => {
  beforeEach(() => {
    daoMock.findOpen.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("findOpen", () => {
    it("lowercasesAndTrimsLocationAndKeyword", async () => {
      await findOpen("  Novi Sad  ", "  DRONE  ", null);

      const query = capturedQuery();
      expect(query.location).toBe("novi sad");
      expect(query.keyword).toBe("drone");
    });

    it("blankFiltersBecomeNull", async () => {
      await findOpen("   ", "", null);

      const query = capturedQuery();
      expect(query.location).toBeNull();
      expect(query.keyword).toBeNull();
    });

    it("nullFiltersStayNull", async () => {
      await findOpen(null, null, null);

      const query = capturedQuery();
      expect(query.location).toBeNull();
      expect(query.keyword).toBeNull();
    });

    it("searchesDifferingOnlyByCaseProduceAnEqualCacheKey", async () => {
      await findOpen("Novi Sad", "Drone", null);
      const first = capturedQuery();

      await findOpen("novi sad", "DRONE", null);
      const second = capturedQuery();

      // The Java assertion is record equality; the cache key here is a pure
      // function of this object (see `openQueryKey` in `mission.cache.ts`),
      // so structural equality is what makes the two searches one entry.
      expect(first).toEqual(second);
    });

    it("statusesAreAlwaysPublishedAndBidding", async () => {
      await findOpen(null, null, null);

      expect([...capturedQuery().statuses]).toEqual(["PUBLISHED", "BIDDING"]);
    });

    it("an absent date leaves the flight-window bounds unset", async () => {
      await findOpen(null, null, undefined);

      const query = capturedQuery();
      expect(query.from).toBeNull();
      expect(query.to).toBeNull();
    });

    it("a date becomes [dayStart, nextDayStart) in the server's local zone", async () => {
      await findOpen(null, null, "2026-05-01");

      const query = capturedQuery();
      // Local midnight, not UTC midnight: `new Date("2026-05-01")` would be
      // the latter, and off by the server's offset.
      expect(query.from).toEqual(new Date(2026, 4, 1));
      expect(query.to).toEqual(new Date(2026, 4, 2));
    });

    it("rolls the exclusive bound over a month end", async () => {
      await findOpen(null, null, "2026-05-31");

      expect(capturedQuery().to).toEqual(new Date(2026, 5, 1));
    });

    it("hands back exactly what the DAO returned", async () => {
      const missions = [fakeMission()];
      daoMock.findOpen.mockResolvedValue(missions);

      await expect(findOpen(null, null, null)).resolves.toBe(missions);
    });
  });

  describe("create", () => {
    it("sets ownership from the designer and audits MISSION_CREATED", async () => {
      const designer = fakeUser({ id: 7 });
      findUserByIdMock.mockResolvedValue(designer);
      const saved = fakeMission({ id: 4, name: "Orchard survey" });
      daoMock.save.mockResolvedValue(saved);

      const result = await create(draft, 7);

      expect(result).toBe(saved);
      expect(daoMock.save).toHaveBeenCalledTimes(1);
      const written = daoMock.save.mock.calls[0][0];
      expect(written.userId).toBe(7);
      expect(written.awardedPilotId).toBeNull();
      expect(written.name).toBe("Orchard survey");
      // Moderation is left unset so `save()` applies its VISIBLE default,
      // mirroring the Java entity's field initializer.
      expect(written.moderation).toBeUndefined();

      expect(recordMock).toHaveBeenCalledTimes(1);
      expect(recordMock.mock.calls[0][0]).toEqual({
        actorId: 7,
        actorRole: "DESIGNER",
        action: "MISSION_CREATED",
        targetType: "MISSION",
        targetId: 4,
        details: '"Orchard survey"',
      });
    });

    it("rejects a suspended designer without saving or auditing", async () => {
      findUserByIdMock.mockResolvedValue(fakeUser({ id: 7, suspended: true }));

      await expect(create(draft, 7)).rejects.toBeInstanceOf(UserSuspendedError);
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("propagates an unknown designer as UserNotFoundError, saving nothing", async () => {
      findUserByIdMock.mockRejectedValue(new UserNotFoundError(99));

      await expect(create(draft, 99)).rejects.toBeInstanceOf(UserNotFoundError);
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });
  });

  describe("findOwnedBy", () => {
    it("returns the caller's own missions regardless of status or moderation", async () => {
      const mine = [fakeMission({ status: "DRAFT", moderation: "HIDDEN" })];
      daoMock.findByUserId.mockResolvedValue(mine);

      await expect(findOwnedBy(7)).resolves.toBe(mine);
      expect(daoMock.findByUserId).toHaveBeenCalledWith(7);
    });
  });

  describe("findById", () => {
    it("reads through the cacheable lookup, never findFresh", async () => {
      daoMock.findById.mockResolvedValue(fakeMission());

      await findById(4, 7);

      expect(daoMock.findById).toHaveBeenCalledWith(4);
      expect(daoMock.findFresh).not.toHaveBeenCalled();
    });

    it("throws MissionNotFoundError when no such mission exists", async () => {
      daoMock.findById.mockResolvedValue(undefined);

      await expect(findById(4, 7)).rejects.toBeInstanceOf(MissionNotFoundError);
    });

    it("shows the owner their own mission even as a DRAFT", async () => {
      const mission = fakeMission({ status: "DRAFT", userId: 7 });
      daoMock.findById.mockResolvedValue(mission);

      await expect(findById(4, 7)).resolves.toBe(mission);
    });

    it("shows the awarded pilot a mission that has left the open statuses", async () => {
      const mission = fakeMission({ status: "IN_PROGRESS", userId: 7, awardedPilotId: 5 });
      daoMock.findById.mockResolvedValue(mission);

      await expect(findById(4, 5)).resolves.toBe(mission);
    });

    it("shows any authenticated caller an open, visible mission", async () => {
      const mission = fakeMission({ status: "BIDDING" });
      daoMock.findById.mockResolvedValue(mission);

      await expect(findById(4, 99)).resolves.toBe(mission);
    });

    it("hides a DRAFT from a stranger as 404, never 403", async () => {
      daoMock.findById.mockResolvedValue(fakeMission({ status: "DRAFT" }));

      // Deliberately not MissionAccessDeniedError: a 403 would itself confirm
      // the draft exists.
      await expect(findById(4, 99)).rejects.toBeInstanceOf(MissionNotFoundError);
    });

    it("hides a HIDDEN mission from a stranger", async () => {
      daoMock.findById.mockResolvedValue(fakeMission({ moderation: "HIDDEN" }));

      await expect(findById(4, 99)).rejects.toBeInstanceOf(MissionNotFoundError);
    });

    it("hides a suspended designer's mission from a stranger but not from its owner", async () => {
      const mission = fakeMission({ designer: fakeUser({ id: 7, suspended: true }) });
      daoMock.findById.mockResolvedValue(mission);

      await expect(findById(4, 99)).rejects.toBeInstanceOf(MissionNotFoundError);
      await expect(findById(4, 7)).resolves.toBe(mission);
    });

    it("still shows a legacy ownerless mission that is open and visible", async () => {
      const mission = fakeMission({ userId: null, designer: null });
      daoMock.findById.mockResolvedValue(mission);

      await expect(findById(4, 99)).resolves.toBe(mission);
    });
  });

  describe("update", () => {
    const changes: MissionDraft = {
      ...draft,
      name: "Orchard survey (revised)",
      // A client cannot promote its own mission: this is ignored.
      status: "COMPLETED",
      location: "Kać",
    };

    it("loads a live row, copies the editable fields and audits MISSION_UPDATED", async () => {
      const existing = fakeMission({ status: "BIDDING", userId: 7, awardedPilotId: null });
      daoMock.findFresh.mockResolvedValue(existing);
      const saved = fakeMission({ name: "Orchard survey (revised)", status: "BIDDING" });
      daoMock.save.mockResolvedValue(saved);

      const result = await update(4, changes, 7);

      expect(result).toBe(saved);
      expect(daoMock.findFresh).toHaveBeenCalledWith(4);
      expect(daoMock.findById).not.toHaveBeenCalled();
      const written = daoMock.save.mock.calls[0][0];
      expect(written.id).toBe(4);
      expect(written.name).toBe("Orchard survey (revised)");
      expect(written.location).toBe("Kać");
      // Never modified by an edit — taken from the loaded row, not the request.
      expect(written.status).toBe("BIDDING");
      expect(written.moderation).toBe("VISIBLE");
      expect(written.userId).toBe(7);

      expect(recordMock.mock.calls[0][0]).toMatchObject({
        actorId: 7,
        actorRole: "DESIGNER",
        action: "MISSION_UPDATED",
        targetType: "MISSION",
        targetId: 4,
        details: '"Orchard survey (revised)"',
      });
    });

    it("rejects a non-owner with 403 and writes nothing", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ userId: 7 }));

      await expect(update(4, changes, 99)).rejects.toBeInstanceOf(MissionAccessDeniedError);
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("throws MissionNotFoundError for a missing mission", async () => {
      daoMock.findFresh.mockResolvedValue(undefined);

      await expect(update(4, changes, 7)).rejects.toBeInstanceOf(MissionNotFoundError);
    });

    it("treats a legacy ownerless mission as owned by nobody", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ userId: null, designer: null }));

      await expect(update(4, changes, 7)).rejects.toBeInstanceOf(MissionAccessDeniedError);
    });
  });

  describe("deleteMission", () => {
    it("deletes an owner's mission and audits it with the pre-delete name", async () => {
      const mission = fakeMission({ id: 4, name: "Orchard survey", userId: 7 });
      daoMock.findFresh.mockResolvedValue(mission);

      await deleteMission(4, 7);

      expect(daoMock.delete).toHaveBeenCalledWith(mission);
      expect(recordMock.mock.calls[0][0]).toMatchObject({
        actorId: 7,
        actorRole: "DESIGNER",
        action: "MISSION_DELETED",
        targetType: "MISSION",
        targetId: 4,
        // The row outlives the mission, so the name is snapshotted.
        details: '"Orchard survey"',
      });
    });

    it("rejects a non-owner with 403 and deletes nothing", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ userId: 7 }));

      await expect(deleteMission(4, 99)).rejects.toBeInstanceOf(MissionAccessDeniedError);
      expect(daoMock.delete).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("throws MissionNotFoundError for a missing mission", async () => {
      daoMock.findFresh.mockResolvedValue(undefined);

      await expect(deleteMission(4, 7)).rejects.toBeInstanceOf(MissionNotFoundError);
      expect(daoMock.delete).not.toHaveBeenCalled();
    });
  });

  describe("findAwardedTo", () => {
    it("returns the pilot's jobs whatever their status or moderation", async () => {
      // A job stays on this list after it leaves the open statuses and after
      // the marketplace hides it — the awarded pilot is exempt from both.
      const jobs = [
        fakeMission({ status: "IN_PROGRESS", moderation: "HIDDEN", awardedPilotId: 5 }),
      ];
      daoMock.findByAwardedPilotId.mockResolvedValue(jobs);

      await expect(findAwardedTo(5)).resolves.toBe(jobs);
      expect(daoMock.findByAwardedPilotId).toHaveBeenCalledWith(5);
    });

    it("never writes — listing a job cannot advance it to IN_PROGRESS", async () => {
      // The guard on the flagged plan-vs-source discrepancy: the plan claims
      // an AWARDED mission whose startTime has passed is promoted lazily on
      // read. The source has no such path, so neither does this.
      const past = new Date(Date.now() - 86_400_000);
      daoMock.findByAwardedPilotId.mockResolvedValue([
        fakeMission({ status: "AWARDED", awardedPilotId: 5, startTime: past, endTime: past }),
      ]);

      const [job] = await findAwardedTo(5);

      expect(job.status).toBe("AWARDED");
      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("findById leaves an overdue AWARDED mission exactly as it found it", async () => {
      const past = new Date(Date.now() - 86_400_000);
      daoMock.findById.mockResolvedValue(
        fakeMission({ status: "AWARDED", awardedPilotId: 5, startTime: past, endTime: past }),
      );

      await expect(findById(4, 5)).resolves.toMatchObject({ status: "AWARDED" });
      expect(daoMock.save).not.toHaveBeenCalled();
    });
  });

  describe("start", () => {
    /** An AWARDED mission owned by designer 7 and awarded to pilot 5. */
    function awarded(overrides: Partial<Mission> = {}): Mission {
      return fakeMission({ status: "AWARDED", userId: 7, awardedPilotId: 5, ...overrides });
    }

    it("moves AWARDED to IN_PROGRESS and audits MISSION_STARTED as the pilot", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());
      findUserByIdMock.mockResolvedValue(fakeUser({ id: 5, role: "PILOT" }));
      const saved = awarded({ status: "IN_PROGRESS" });
      daoMock.save.mockResolvedValue(saved);

      const result = await start(4, 5);

      expect(result).toBe(saved);
      // A write path, so the live row — never the cacheable lookup.
      expect(daoMock.findFresh).toHaveBeenCalledWith(4);
      expect(daoMock.findById).not.toHaveBeenCalled();
      const written = daoMock.save.mock.calls[0][0];
      expect(written.id).toBe(4);
      expect(written.status).toBe("IN_PROGRESS");
      expect(written.awardedPilotId).toBe(5);

      expect(recordMock.mock.calls[0][0]).toMatchObject({
        actorId: 5,
        // PILOT, not DESIGNER: the constant restates who is allowed to start it.
        actorRole: "PILOT",
        action: "MISSION_STARTED",
        targetType: "MISSION",
        targetId: 4,
        details: '"Orchard survey"',
      });
    });

    it("raises no notification and sends no email", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());
      findUserByIdMock.mockResolvedValue(fakeUser({ id: 5, role: "PILOT" }));
      daoMock.save.mockResolvedValue(awarded({ status: "IN_PROGRESS" }));

      await start(4, 5);

      expect(createNotificationMock).not.toHaveBeenCalled();
      expect(sendMissionCancelledMock).not.toHaveBeenCalled();
    });

    it("rejects anyone who is not the awarded pilot with 403", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());

      // Including the mission's own designer: starting is the pilot's act.
      await expect(start(4, 7)).rejects.toBeInstanceOf(MissionAccessDeniedError);
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("rejects everyone while no pilot has been awarded", async () => {
      daoMock.findFresh.mockResolvedValue(awarded({ status: "BIDDING", awardedPilotId: null }));

      await expect(start(4, 5)).rejects.toBeInstanceOf(MissionAccessDeniedError);
      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("rejects a suspended awarded pilot", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());
      findUserByIdMock.mockResolvedValue(fakeUser({ id: 5, role: "PILOT", suspended: true }));

      await expect(start(4, 5)).rejects.toBeInstanceOf(UserSuspendedError);
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("refuses any status other than AWARDED, naming it in the conflict", async () => {
      daoMock.findFresh.mockResolvedValue(awarded({ status: "IN_PROGRESS" }));
      findUserByIdMock.mockResolvedValue(fakeUser({ id: 5, role: "PILOT" }));

      // Started once, never started twice.
      await expect(start(4, 5)).rejects.toThrow(
        "Mission 4 cannot be started from status IN_PROGRESS",
      );
      await expect(start(4, 5)).rejects.toBeInstanceOf(MissionConflictError);
      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("throws MissionNotFoundError for a missing mission", async () => {
      daoMock.findFresh.mockResolvedValue(undefined);

      await expect(start(4, 5)).rejects.toBeInstanceOf(MissionNotFoundError);
    });
  });

  describe("complete", () => {
    /** An IN_PROGRESS mission owned by designer 7 and awarded to pilot 5. */
    function underway(overrides: Partial<Mission> = {}): Mission {
      return fakeMission({ status: "IN_PROGRESS", userId: 7, awardedPilotId: 5, ...overrides });
    }

    it("moves IN_PROGRESS to COMPLETED and audits MISSION_COMPLETED as the pilot", async () => {
      daoMock.findFresh.mockResolvedValue(underway());
      findUserByIdMock.mockResolvedValue(fakeUser({ id: 5, role: "PILOT" }));
      const saved = underway({ status: "COMPLETED" });
      daoMock.save.mockResolvedValue(saved);

      const result = await complete(4, 5);

      expect(result).toBe(saved);
      expect(daoMock.findFresh).toHaveBeenCalledWith(4);
      expect(daoMock.findById).not.toHaveBeenCalled();
      expect(daoMock.save.mock.calls[0][0].status).toBe("COMPLETED");
      expect(recordMock.mock.calls[0][0]).toMatchObject({
        actorId: 5,
        actorRole: "PILOT",
        action: "MISSION_COMPLETED",
        targetType: "MISSION",
        targetId: 4,
        details: '"Orchard survey"',
      });
      expect(createNotificationMock).not.toHaveBeenCalled();
    });

    it("rejects anyone who is not the awarded pilot with 403", async () => {
      daoMock.findFresh.mockResolvedValue(underway());

      await expect(complete(4, 7)).rejects.toBeInstanceOf(MissionAccessDeniedError);
      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("rejects a suspended awarded pilot", async () => {
      daoMock.findFresh.mockResolvedValue(underway());
      findUserByIdMock.mockResolvedValue(fakeUser({ id: 5, role: "PILOT", suspended: true }));

      await expect(complete(4, 5)).rejects.toBeInstanceOf(UserSuspendedError);
      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("refuses a mission that was never started", async () => {
      daoMock.findFresh.mockResolvedValue(underway({ status: "AWARDED" }));
      findUserByIdMock.mockResolvedValue(fakeUser({ id: 5, role: "PILOT" }));

      await expect(complete(4, 5)).rejects.toThrow(
        "Mission 4 cannot be completed from status AWARDED",
      );
      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("refuses to complete an already completed mission", async () => {
      daoMock.findFresh.mockResolvedValue(underway({ status: "COMPLETED" }));
      findUserByIdMock.mockResolvedValue(fakeUser({ id: 5, role: "PILOT" }));

      await expect(complete(4, 5)).rejects.toBeInstanceOf(MissionConflictError);
      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("throws MissionNotFoundError for a missing mission", async () => {
      daoMock.findFresh.mockResolvedValue(undefined);

      await expect(complete(4, 5)).rejects.toBeInstanceOf(MissionNotFoundError);
    });
  });

  describe("cancel", () => {
    /** An AWARDED mission owned by designer 7, awarded to pilot 5. */
    function awarded(overrides: Partial<Mission> = {}): Mission {
      return fakeMission({ status: "AWARDED", userId: 7, awardedPilotId: 5, ...overrides });
    }

    beforeEach(() => {
      findBidsMock.mockResolvedValue([]);
      saveBidMock.mockImplementation(async (input: unknown) => input);
      findUserByIdOrUndefinedMock.mockResolvedValue(
        fakeUser({ id: 5, username: "pia", email: "pia@example.com", role: "PILOT" }),
      );
    });

    it("cancels the mission and audits MISSION_CANCELLED as the designer", async () => {
      daoMock.findFresh.mockResolvedValue(awarded({ status: "BIDDING", awardedPilotId: null }));
      const saved = awarded({ status: "CANCELLED", awardedPilotId: null });
      daoMock.save.mockResolvedValue(saved);

      const result = await cancel(4, 7);

      expect(result).toBe(saved);
      expect(daoMock.findFresh).toHaveBeenCalledWith(4);
      expect(daoMock.findById).not.toHaveBeenCalled();
      expect(daoMock.save.mock.calls[0][0].status).toBe("CANCELLED");
      expect(recordMock.mock.calls[0][0]).toMatchObject({
        actorId: 7,
        actorRole: "DESIGNER",
        action: "MISSION_CANCELLED",
        targetType: "MISSION",
        targetId: 4,
        details: '"Orchard survey"',
      });
    });

    it("rejects every PENDING and ACCEPTED bid, leaving decided ones alone", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());
      daoMock.save.mockResolvedValue(awarded({ status: "CANCELLED" }));
      findBidsMock.mockResolvedValue([
        fakeBid({ id: 11, status: "ACCEPTED", pilotId: 5 }),
        fakeBid({ id: 12, status: "PENDING", pilotId: 6 }),
        fakeBid({ id: 13, status: "REJECTED", pilotId: 8 }),
      ]);

      await cancel(4, 7);

      // The winner's own ACCEPTED bid goes too — the work no longer exists.
      expect(saveBidMock).toHaveBeenCalledTimes(2);
      const written = saveBidMock.mock.calls.map((call) => call[0]);
      expect(written.map((b) => b.id)).toEqual([11, 12]);
      expect(written.every((b) => b.status === "REJECTED")).toBe(true);
    });

    it("writes the mission and the bids on one transaction, then evicts the cache", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());
      daoMock.save.mockResolvedValue(awarded({ status: "CANCELLED" }));
      findBidsMock.mockResolvedValue([fakeBid({ id: 11, status: "PENDING" })]);

      await cancel(4, 7);

      expect(transactionMock).toHaveBeenCalledTimes(1);
      // Every write carries the transaction handle: a mission left CANCELLED
      // beside an ACCEPTED bid is the state this atomicity exists to prevent.
      expect(daoMock.save.mock.calls[0][1]).toBe(txHandle);
      expect(findBidsMock).toHaveBeenCalledWith(4, txHandle);
      expect(saveBidMock.mock.calls[0][1]).toBe(txHandle);
      // The hand-run half of the source's `afterCompletion` eviction.
      expect(daoMock.invalidate).toHaveBeenCalledWith(4);
    });

    it("propagates a mid-transaction failure and runs none of the post-commit work", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());
      daoMock.save.mockResolvedValue(awarded({ status: "CANCELLED" }));
      findBidsMock.mockResolvedValue([fakeBid({ id: 11, status: "ACCEPTED", pilotId: 5 })]);
      // The rejection fails after the mission has already been written
      // CANCELLED. What that rolls *back* is a property of a real Postgres
      // transaction and is pinned in `mission.service.live.test.ts`, where the
      // failure is injected into an open transaction over real rows; what a
      // stubbed `transaction()` can show is the other half — that everything
      // sequenced after the commit is skipped.
      saveBidMock.mockRejectedValue(new Error("bid rejection failed"));

      await expect(cancel(4, 7)).rejects.toThrow("bid rejection failed");

      // No second eviction, no notification, no email, no audit entry: the
      // failure surfaces to the caller instead of a cancellation being
      // announced that the database never kept.
      expect(daoMock.invalidate).not.toHaveBeenCalled();
      expect(createNotificationMock).not.toHaveBeenCalled();
      expect(sendMissionCancelledMock).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("notifies and emails the awarded pilot", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());
      daoMock.save.mockResolvedValue(awarded({ status: "CANCELLED" }));

      await cancel(4, 7);

      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      expect(createNotificationMock.mock.calls[0][0]).toMatchObject({
        userId: 5,
        type: "MISSION_CANCELLED",
        title: "Mission cancelled",
        message: '"Orchard survey" was cancelled by the designer.',
      });
      expect(sendMissionCancelledMock).toHaveBeenCalledWith(
        { email: "pia@example.com", username: "pia" },
        { id: 4, name: "Orchard survey", location: "Novi Sad" },
      );
    });

    it("tells nobody when the mission was never awarded", async () => {
      daoMock.findFresh.mockResolvedValue(awarded({ status: "BIDDING", awardedPilotId: null }));
      daoMock.save.mockResolvedValue(awarded({ status: "CANCELLED", awardedPilotId: null }));
      findBidsMock.mockResolvedValue([fakeBid({ id: 12, status: "PENDING" })]);

      await cancel(4, 7);

      // The losing bidders are rejected, not notified — the source announces
      // the cancellation only to the pilot who had already won it.
      expect(saveBidMock).toHaveBeenCalledTimes(1);
      expect(createNotificationMock).not.toHaveBeenCalled();
      expect(sendMissionCancelledMock).not.toHaveBeenCalled();
      expect(recordMock).toHaveBeenCalledTimes(1);
    });

    it("still cancels when the awarded pilot's account has since vanished", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());
      daoMock.save.mockResolvedValue(awarded({ status: "CANCELLED" }));
      findUserByIdOrUndefinedMock.mockResolvedValue(undefined);

      await cancel(4, 7);

      // `.ifPresent` in the source: an absent mailbox never undoes a write.
      expect(sendMissionCancelledMock).not.toHaveBeenCalled();
      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      expect(recordMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-owner with 403 and opens no transaction", async () => {
      daoMock.findFresh.mockResolvedValue(awarded());

      // Not even the awarded pilot may cancel: it is the designer's act.
      await expect(cancel(4, 5)).rejects.toBeInstanceOf(MissionAccessDeniedError);
      expect(transactionMock).not.toHaveBeenCalled();
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("refuses a COMPLETED mission, naming the status", async () => {
      daoMock.findFresh.mockResolvedValue(awarded({ status: "COMPLETED" }));

      await expect(cancel(4, 7)).rejects.toThrow(
        "Mission 4 cannot be cancelled from status COMPLETED",
      );
      await expect(cancel(4, 7)).rejects.toBeInstanceOf(MissionConflictError);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it("refuses a mission that is already CANCELLED", async () => {
      daoMock.findFresh.mockResolvedValue(awarded({ status: "CANCELLED" }));

      await expect(cancel(4, 7)).rejects.toBeInstanceOf(MissionConflictError);
      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("cancels a mission that is already underway", async () => {
      daoMock.findFresh.mockResolvedValue(awarded({ status: "IN_PROGRESS" }));
      daoMock.save.mockResolvedValue(awarded({ status: "CANCELLED" }));

      // Allowed from every status short of COMPLETED — which is exactly why
      // the pilot flying it has to be told.
      await cancel(4, 7);

      expect(daoMock.save.mock.calls[0][0].status).toBe("CANCELLED");
      expect(createNotificationMock).toHaveBeenCalledTimes(1);
    });

    it("throws MissionNotFoundError for a missing mission", async () => {
      daoMock.findFresh.mockResolvedValue(undefined);

      await expect(cancel(4, 7)).rejects.toBeInstanceOf(MissionNotFoundError);
      expect(transactionMock).not.toHaveBeenCalled();
    });
  });

  describe("searchAll", () => {
    const request = { page: 0, size: 20 };

    beforeEach(() => {
      daoMock.searchAll.mockResolvedValue({ content: [], request, totalElements: 0 });
    });

    /** Mirrors `adminSearchBuildsALowercasePatternAndBlankMeansEverything`. */
    it("adminSearchBuildsALowercasePatternAndBlankMeansEverything", async () => {
      await searchAll("   ", request);
      expect(daoMock.searchAll).toHaveBeenLastCalledWith(null, request);

      await searchAll(" Orchard ", request);
      expect(daoMock.searchAll).toHaveBeenLastCalledWith("%orchard%", request);
    });

    it("treats an absent q as 'everything' too", async () => {
      // The route hands `undefined` when `?q` is not present at all, where the
      // Java controller's `@RequestParam(required = false)` hands null.
      await searchAll(undefined, request);

      expect(daoMock.searchAll).toHaveBeenLastCalledWith(null, request);
    });

    it("hands back exactly the page the DAO returned", async () => {
      const page = { content: [fakeMission()], request, totalElements: 1 };
      daoMock.searchAll.mockResolvedValue(page);

      await expect(searchAll(null, request)).resolves.toBe(page);
    });

    it("applies no visibility or moderation filter of its own", async () => {
      // The admin listing is the one view that must show drafts and hidden
      // missions: the service adds nothing but the pattern, so whatever the
      // query returns is what the admin sees.
      const hidden = fakeMission({ status: "DRAFT", moderation: "HIDDEN" });
      daoMock.searchAll.mockResolvedValue({ content: [hidden], request, totalElements: 1 });

      await expect(searchAll(null, request)).resolves.toMatchObject({ content: [hidden] });
    });
  });

  describe("hide / unhide", () => {
    it("hideMovesVisibleToHiddenAndRecordsTheAdmin", async () => {
      const mission = fakeMission({ id: 1, status: "PUBLISHED", moderation: "VISIBLE" });
      daoMock.findFresh.mockResolvedValue(mission);
      daoMock.save.mockImplementation(async (m: Mission) => m);

      await expect(hide(1, 9)).resolves.toMatchObject({ moderation: "HIDDEN" });

      expect(recordMock.mock.calls[0][0]).toMatchObject({
        actorId: 9,
        // ADMIN, not the mission's designer — moderation is an admin act.
        actorRole: "ADMIN",
        action: "MISSION_HIDDEN",
        targetType: "MISSION",
        targetId: 1,
      });
    });

    it("hideRejectsAlreadyHidden", async () => {
      daoMock.findFresh.mockResolvedValue(
        fakeMission({ id: 1, status: "PUBLISHED", moderation: "HIDDEN" }),
      );

      await expect(hide(1, 9)).rejects.toBeInstanceOf(MissionConflictError);
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("names the current moderation and the target, as the source's message does", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ id: 1, moderation: "HIDDEN" }));

      // Verbatim from `"Mission %d cannot go from %s to %s"` — the second `%s`
      // is the *target* state, so refusing to hide an already hidden mission
      // reads "from HIDDEN to HIDDEN". Odd-looking and deliberately kept: the
      // Angular client surfaces this text verbatim in its error toast.
      await expect(hide(1, 9)).rejects.toThrow("Mission 1 cannot go from HIDDEN to HIDDEN");
    });

    it("unhide moves HIDDEN back to VISIBLE and records the admin", async () => {
      const mission = fakeMission({ id: 1, moderation: "HIDDEN" });
      daoMock.findFresh.mockResolvedValue(mission);
      daoMock.save.mockImplementation(async (m: Mission) => m);

      await expect(unhide(1, 9)).resolves.toMatchObject({ moderation: "VISIBLE" });

      expect(recordMock.mock.calls[0][0]).toMatchObject({
        actorId: 9,
        actorRole: "ADMIN",
        action: "MISSION_UNHIDDEN",
        targetId: 1,
      });
    });

    it("unhide rejects a mission that is already VISIBLE", async () => {
      daoMock.findFresh.mockResolvedValue(fakeMission({ id: 1, moderation: "VISIBLE" }));

      await expect(unhide(1, 9)).rejects.toBeInstanceOf(MissionConflictError);
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("changes nothing but the moderation flag", async () => {
      // `moderate` loads a live row and saves it back, so the status, owner and
      // awarded pilot have to survive untouched — the same rule `update` obeys.
      const mission = fakeMission({
        id: 1,
        status: "IN_PROGRESS",
        userId: 7,
        awardedPilotId: 5,
        moderation: "VISIBLE",
      });
      daoMock.findFresh.mockResolvedValue(mission);
      daoMock.save.mockImplementation(async (m: Mission) => m);

      await hide(1, 9);

      expect(daoMock.save.mock.calls[0][0]).toMatchObject({
        status: "IN_PROGRESS",
        userId: 7,
        awardedPilotId: 5,
        moderation: "HIDDEN",
      });
    });

    it("throws MissionNotFoundError for a missing mission", async () => {
      daoMock.findFresh.mockResolvedValue(undefined);

      await expect(hide(1, 9)).rejects.toBeInstanceOf(MissionNotFoundError);
      await expect(unhide(1, 9)).rejects.toBeInstanceOf(MissionNotFoundError);
      expect(daoMock.save).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("removeDeletesTheMissionAndRecordsTheAdmin", async () => {
      const mission = fakeMission({
        id: 1,
        name: "Orchard survey",
        status: "PUBLISHED",
        moderation: "HIDDEN",
      });
      daoMock.findFresh.mockResolvedValue(mission);

      await remove(1, 9);

      expect(daoMock.delete).toHaveBeenCalledWith(mission);
      expect(recordMock.mock.calls[0][0]).toMatchObject({
        actorId: 9,
        actorRole: "ADMIN",
        action: "MISSION_REMOVED",
        targetType: "MISSION",
        targetId: 1,
        // The hard delete cascades everything else away, so this row is all
        // that is left of the mission — hence the snapshotted name.
        details: '"Orchard survey"',
      });
    });

    it("removingAMissingMissionIsANotFound", async () => {
      daoMock.findFresh.mockResolvedValue(undefined);

      await expect(remove(1, 9)).rejects.toBeInstanceOf(MissionNotFoundError);
      expect(daoMock.delete).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("removes a mission in any state, owned by anyone", async () => {
      // No ownership check and no status guard: unlike `deleteMission`, an
      // admin may remove any mission there is.
      const mission = fakeMission({ id: 1, status: "COMPLETED", userId: 7, awardedPilotId: 5 });
      daoMock.findFresh.mockResolvedValue(mission);

      await remove(1, 9);

      expect(daoMock.delete).toHaveBeenCalledWith(mission);
    });
  });
});
