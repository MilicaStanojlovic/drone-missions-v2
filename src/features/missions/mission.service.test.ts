import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/features/users/user.types";
import { UserSuspendedError } from "@/features/users/user.service";
import { UserNotFoundError } from "@/features/users/user.queries";
import type { Mission, MissionStatus } from "./mission.types";
import type { OpenMissionQuery } from "./mission.queries";

/**
 * Vitest suite for `mission.service.ts`.
 *
 * Mirrors the phase-2 cases of `MissionServiceTest` — the `findOpen`
 * normalisation ones, which pin what keeps case-different searches for the
 * same thing (e.g. "Novi Sad" vs. "novi sad") from becoming two distinct,
 * duplicate list-cache entries: `lowercasesAndTrimsLocationAndKeyword`,
 * `blankFiltersBecomeNull`, `nullFiltersStayNull`,
 * `searchesDifferingOnlyByCaseProduceAnEqualCacheKey`,
 * `statusesAreAlwaysPublishedAndBidding`. Its sixth case,
 * `adminSearchBuildsALowercasePatternAndBlankMeansEverything`, is skipped —
 * `searchAll` has no port yet, it's Phase 7.
 *
 * The Java suite stops at `findOpen`, because that is the method issue #12
 * was about; the create/visibility/ownership rules it leaves to
 * `MissionControllerTest` are covered here too, since this port's route
 * handlers are thin and those rules live entirely in this module.
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
  invalidateLists: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};
vi.mock("./mission.cache", () => ({ getMissionDao: () => daoMock }));

const findUserByIdMock = vi.fn();
vi.mock("@/features/users/user.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/users/user.queries")>();
  return { ...actual, findById: (...args: unknown[]) => findUserByIdMock(...args) };
});

const recordMock = vi.fn();
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, record: (...args: unknown[]) => recordMock(...args) };
});

// `vi.mock` calls above are hoisted by Vitest, so these static imports
// already resolve against the mocked modules.
import {
  create,
  deleteMission,
  findById,
  findOpen,
  findOwnedBy,
  MissionAccessDeniedError,
  MissionNotFoundError,
  update,
  type MissionDraft,
} from "./mission.service";

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
});
