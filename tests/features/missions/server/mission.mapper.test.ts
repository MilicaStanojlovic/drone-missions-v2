import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/features/users/user.types";
import type { RatingSummary } from "@/features/ratings/server/rating.queries";
import type { Mission } from "@/features/missions/mission.types";

/**
 * Vitest suite for `mission.mapper.ts`.
 *
 * The Java `MissionMapper` has no unit test of its own; these cases pin the
 * behaviors its callers' tests do assert — the null-designer handling that
 * `MissionControllerTest` covers ("the open feed survives an ownerless
 * mission", "a single ownerless mission still renders"), and the
 * one-aggregate-query-per-page rule the controller's `toResponses` exists for.
 *
 * `rating.queries.ts`'s two DB-hitting functions are mocked; its pure
 * `summaryOf` helper runs for real, so the ownerless-mission default is
 * genuinely exercised rather than stubbed.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/mapper/mission/MissionMapper.java
 * - drone-missions-backend/.../web/controller/mission/MissionController.java (`toResponses`, `toResponse`, `ratingOf`)
 * - test drone-missions-backend/.../web/controller/mission/MissionControllerTest.java
 */

const summariesForMock = vi.fn();
const summaryForMock = vi.fn();
vi.mock("@/features/ratings/server/rating.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/ratings/server/rating.queries")>();
  return {
    ...actual,
    summariesFor: (...args: unknown[]) => summariesForMock(...args),
    summaryFor: (...args: unknown[]) => summaryForMock(...args),
  };
});

// `vi.mock` is hoisted, so these already resolve against the mock.
import { loadMissionResponse, loadMissionResponses, toMissionResponse } from "@/features/missions/server/mission.mapper";

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
    status: "PUBLISHED",
    moderation: "VISIBLE",
    userId: 7,
    awardedPilotId: null,
    startTime: new Date("2026-05-01T08:00:00Z"),
    endTime: new Date("2026-05-01T10:00:00Z"),
    location: "Novi Sad",
    biddingDeadline: "2026-04-25",
    waypoints: [
      { lat: 45.25, lng: 19.83, altitude: 40, action: "PHOTO" },
      { lat: 45.26, lng: 19.84, altitude: 40, action: "HOVER", hoverDurationSeconds: 30 },
    ],
    geofence: { type: "CIRCLE", center: { lat: 45.25, lng: 19.83 }, radiusMeters: 500 },
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-02T00:00:00Z"),
    designer: fakeUser(),
    ...overrides,
  };
}

const rating: RatingSummary = { average: 4.5, count: 8 };

describe("mission.mapper.ts", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("toMissionResponse", () => {
    it("maps every MissionResponse field, flattening the designer off the join", () => {
      const mission = fakeMission();

      expect(toMissionResponse(mission, rating)).toEqual({
        id: 4,
        name: "Orchard survey",
        description: "Fly the north rows",
        status: "PUBLISHED",
        moderation: "VISIBLE",
        // Named after the column, and it is the designer's id.
        userId: 7,
        designerEmail: "dana@example.com",
        // The account's username — what the Angular cards show.
        designerName: "dana",
        designerSuspended: false,
        designerRating: 4.5,
        designerRatingCount: 8,
        awardedPilotId: null,
        startTime: mission.startTime,
        endTime: mission.endTime,
        location: "Novi Sad",
        // A calendar day stays a string, never a zoned Date.
        biddingDeadline: "2026-04-25",
        waypoints: mission.waypoints,
        geofence: mission.geofence,
        createdAt: mission.createdAt,
        updatedAt: mission.updatedAt,
      });
    });

    it("reports a suspended designer", () => {
      const response = toMissionResponse(
        fakeMission({ designer: fakeUser({ suspended: true }) }),
        rating,
      );

      expect(response.designerSuspended).toBe(true);
    });

    it("renders a legacy ownerless mission with null designer fields, not a crash", () => {
      const response = toMissionResponse(fakeMission({ userId: null, designer: null }), {
        average: 0,
        count: 0,
      });

      expect(response.userId).toBeNull();
      expect(response.designerEmail).toBeNull();
      expect(response.designerName).toBeNull();
      // `false`, not null — the Java field is a primitive boolean.
      expect(response.designerSuspended).toBe(false);
    });

    it("passes the supplied summary straight through rather than looking one up", () => {
      const response = toMissionResponse(fakeMission(), { average: 3.25, count: 2 });

      expect(response.designerRating).toBe(3.25);
      expect(response.designerRatingCount).toBe(2);
      expect(summaryForMock).not.toHaveBeenCalled();
      expect(summariesForMock).not.toHaveBeenCalled();
    });
  });

  describe("loadMissionResponses", () => {
    it("costs one aggregate query for a whole page", async () => {
      summariesForMock.mockResolvedValue(
        new Map([
          [7, { average: 4.5, count: 8 }],
          [8, { average: 2, count: 1 }],
        ]),
      );
      const missions = [
        fakeMission({ id: 1, userId: 7, designer: fakeUser({ id: 7 }) }),
        fakeMission({ id: 2, userId: 8, designer: fakeUser({ id: 8, username: "ivo" }) }),
        fakeMission({ id: 3, userId: 7, designer: fakeUser({ id: 7 }) }),
      ];

      const responses = await loadMissionResponses(missions);

      expect(summariesForMock).toHaveBeenCalledTimes(1);
      expect(summariesForMock).toHaveBeenCalledWith([7, 8, 7]);
      expect(responses.map((r) => [r.id, r.designerRating, r.designerRatingCount])).toEqual([
        [1, 4.5, 8],
        [2, 2, 1],
        [3, 4.5, 8],
      ]);
    });

    it("defaults an unrated designer to 0/0", async () => {
      summariesForMock.mockResolvedValue(new Map());

      const [response] = await loadMissionResponses([fakeMission()]);

      expect(response.designerRating).toBe(0);
      expect(response.designerRatingCount).toBe(0);
    });

    it("survives an ownerless mission mixed into the feed", async () => {
      summariesForMock.mockResolvedValue(new Map([[7, { average: 4.5, count: 8 }]]));
      const missions = [
        fakeMission({ id: 1, userId: 7 }),
        fakeMission({ id: 2, userId: null, designer: null }),
      ];

      const responses = await loadMissionResponses(missions);

      expect(responses).toHaveLength(2);
      expect(responses[1].userId).toBeNull();
      expect(responses[1].designerRating).toBe(0);
      expect(responses[1].designerRatingCount).toBe(0);
    });

    it("renders a page of only ownerless missions", async () => {
      // The Java equivalent returns an immutable empty map here, where a null
      // key lookup throws — hence `ratingOf`'s null guard, ported as `summaryOf`.
      summariesForMock.mockResolvedValue(new Map());

      const responses = await loadMissionResponses([
        fakeMission({ id: 1, userId: null, designer: null }),
      ]);

      expect(responses).toHaveLength(1);
      expect(responses[0].designerSuspended).toBe(false);
    });

    it("returns an empty list without shaping anything", async () => {
      summariesForMock.mockResolvedValue(new Map());

      await expect(loadMissionResponses([])).resolves.toEqual([]);
    });
  });

  describe("loadMissionResponse", () => {
    it("looks up the designer's summary by the mission's owner id", async () => {
      summaryForMock.mockResolvedValue({ average: 4.5, count: 8 });

      const response = await loadMissionResponse(fakeMission());

      expect(summaryForMock).toHaveBeenCalledWith(7);
      expect(response.designerRating).toBe(4.5);
      expect(response.designerRatingCount).toBe(8);
    });

    it("renders a single ownerless mission", async () => {
      summaryForMock.mockResolvedValue({ average: 0, count: 0 });

      const response = await loadMissionResponse(fakeMission({ userId: null, designer: null }));

      expect(summaryForMock).toHaveBeenCalledWith(null);
      expect(response.designerName).toBeNull();
      expect(response.designerRating).toBe(0);
    });
  });
});
