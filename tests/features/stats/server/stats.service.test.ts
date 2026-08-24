import { beforeEach, describe, expect, it, vi } from "vitest";
import { MISSION_STATUSES, USER_ROLES } from "@/db/schema";
import type { MissionDao } from "@/features/missions/mission.cache";

/**
 * Vitest suite for `stats.service.ts`.
 *
 * Mirrors all six cases of `PlatformStatsServiceTest` one-for-one —
 * `sparseStatusCountsAreZeroFilledToAllStatuses`,
 * `anEmptyPlatformReportsAllZeros`,
 * `activePilotsCountsExactlyTheUnsuspendedPilotRole`,
 * `bidVolumeLandsInTheRightComponents`,
 * `sparseRoleCountsAreZeroFilledToAllRoles` and
 * `topMissionsAreCappedAtSixAndKeepTheirOrder` — each named below after the
 * case it ports, with the same stubbed numbers (7 active pilots, 57 bids
 * totalling 12345.50, 31 pilots, 3 suspended, "Orchard survey"/9 and
 * "Roof scan"/4).
 *
 * Three collaborators are mocked, matching the Java test's three `@Mock`s:
 * `bid.queries.ts` and `user.queries.ts` stand in for `BidRepository` and
 * `UserRepository`, and `mission.cache.ts`'s DAO for `MissionDao` — the service
 * reads mission counts through `getMissionDao()`, so the DAO is what has to be
 * mocked, not `mission.queries.ts` behind it.
 *
 * `beforeEach` reproduces the Java `setUp()` stubs (empty volume, empty top
 * list, empty role counts) and additionally pins the two plain counts and
 * `countByStatus` to their zero/empty answers. Mockito hands back `0L` for an
 * unstubbed `long` method and the Java suite leans on that; a `vi.fn()` with no
 * `mockResolvedValue` answers `undefined`, which would surface as `undefined`
 * tiles rather than the zeros the source's defaults produce. Pinning them here
 * is the port of Mockito's default answer, and every case below still overrides
 * exactly the stubs its Java twin overrides.
 *
 * What this suite cannot show is whether the SQL under those mocks counts the
 * right rows: that is `bid.queries.test.ts` / `user.queries.test.ts` /
 * `mission.queries.test.ts` (live-DB), and end-to-end
 * `src/app/api/v1/platform-stats/routes.live.test.ts`. The division is the same
 * one `user.service.test.ts` documents.
 *
 * SOURCE:
 * - drone-missions-backend/.../src/test/.../business/service/stats/PlatformStatsServiceTest.java
 * - drone-missions-backend/.../business/service/stats/PlatformStatsService.java
 */

const countByStatusMock = vi.fn();
/**
 * Stands in for the Java test's `@Mock MissionDao`. Only `countByStatus` is
 * ever reached from this service, but the whole contract is stubbed so the
 * object is a genuine `MissionDao` — and `satisfies MissionDao` keeps that
 * claim honest, so a method added to the interface later cannot go missing here
 * silently. Same construction as `user.service.test.ts`'s DAO mock.
 */
const daoMock = {
  findById: vi.fn(),
  findFresh: vi.fn(),
  findOpen: vi.fn(),
  findByUserId: vi.fn(),
  findByAwardedPilotId: vi.fn(),
  findOverdue: vi.fn(),
  searchAll: vi.fn(),
  countByStatus: (...args: unknown[]) => countByStatusMock(...args),
  invalidateLists: vi.fn(),
  invalidate: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
} satisfies MissionDao;
vi.mock("@/features/missions/mission.cache", () => ({ getMissionDao: () => daoMock }));

const volumeMock = vi.fn();
const topMissionsByBidsMock = vi.fn();
vi.mock("@/features/bids/bid.queries", () => ({
  volume: (...args: unknown[]) => volumeMock(...args),
  topMissionsByBids: (...args: unknown[]) => topMissionsByBidsMock(...args),
}));

const countByRoleMock = vi.fn();
const countByRoleAndSuspendedFalseMock = vi.fn();
const countBySuspendedTrueMock = vi.fn();
vi.mock("@/features/users/user.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/users/user.queries")>();
  return {
    ...actual,
    countByRole: (...args: unknown[]) => countByRoleMock(...args),
    countByRoleAndSuspendedFalse: (...args: unknown[]) => countByRoleAndSuspendedFalseMock(...args),
    countBySuspendedTrue: (...args: unknown[]) => countBySuspendedTrueMock(...args),
  };
});

// `vi.mock` calls above are hoisted by Vitest, so this static import already
// resolves against the mocked modules.
import { overview } from "@/features/stats/stats.service";

/** The Java `setUp()`, plus Mockito's default `0L` answers made explicit. */
beforeEach(() => {
  vi.clearAllMocks();
  countByStatusMock.mockResolvedValue({});
  volumeMock.mockResolvedValue({ count: 0, totalAmount: 0 });
  topMissionsByBidsMock.mockResolvedValue([]);
  countByRoleMock.mockResolvedValue([]);
  countByRoleAndSuspendedFalseMock.mockResolvedValue(0);
  countBySuspendedTrueMock.mockResolvedValue(0);
});

describe("stats.service.ts overview", () => {
  // Mirrors `sparseStatusCountsAreZeroFilledToAllStatuses`.
  it("zero-fills the sparse status counts to every mission status", async () => {
    countByStatusMock.mockResolvedValue({ PUBLISHED: 2 });

    const byStatus = (await overview()).missionsByStatus;

    // `containsOnlyKeys(MissionStatus.values())`: every status, and nothing
    // else. Compared as an array rather than a set because the seeding order
    // is part of the contract (see `stats.service.ts`) — the source's
    // `EnumMap` fixes it to declaration order, and so does `MISSION_STATUSES`.
    expect(Object.keys(byStatus)).toEqual(MISSION_STATUSES);
    expect(byStatus.PUBLISHED).toBe(2);
    expect(byStatus.DRAFT).toBe(0);
    expect(byStatus.CANCELLED).toBe(0);
  });

  // Mirrors `anEmptyPlatformReportsAllZeros`.
  it("reports all zeros for an empty platform", async () => {
    const stats = await overview();

    expect(Object.values(stats.missionsByStatus)).toEqual(MISSION_STATUSES.map(() => 0));
    expect(Object.keys(stats.usersByRole)).toEqual(USER_ROLES);
    expect(Object.values(stats.usersByRole)).toEqual(USER_ROLES.map(() => 0));
    expect(stats.activePilots).toBe(0);
    expect(stats.suspendedUsers).toBe(0);
    expect(stats.bidCount).toBe(0);
    expect(stats.bidAmountTotal).toBe(0);
    expect(stats.topMissionsByBids).toEqual([]);
  });

  // Mirrors `activePilotsCountsExactlyTheUnsuspendedPilotRole`.
  it("counts exactly the unsuspended PILOT role as active pilots", async () => {
    countByRoleAndSuspendedFalseMock.mockResolvedValue(7);

    expect((await overview()).activePilots).toBe(7);
    // The Java `verify(userRepository).countByRoleAndSuspendedFalse(PILOT)` —
    // the argument is the whole point of the case: 'active pilots' must not be
    // filled from the all-roles count or from an unfiltered pilot count.
    expect(countByRoleAndSuspendedFalseMock).toHaveBeenCalledWith("PILOT");
    expect(countByRoleAndSuspendedFalseMock).toHaveBeenCalledTimes(1);
  });

  // Mirrors `bidVolumeLandsInTheRightComponents`.
  it("lands the bid volume in the right components", async () => {
    volumeMock.mockResolvedValue({ count: 57, totalAmount: 12345.5 });

    const stats = await overview();

    expect(stats.bidCount).toBe(57);
    // The source compares `BigDecimal`s by value (`isEqualByComparingTo`);
    // here the query layer has already narrowed the numeric sum to a `number`
    // (`bid.queries.ts` `volume()`), so the total travels through this service
    // untouched — a strict equality is the stronger assertion.
    expect(stats.bidAmountTotal).toBe(12345.5);
  });

  // Mirrors `sparseRoleCountsAreZeroFilledToAllRoles`.
  it("zero-fills the sparse role counts to every role and reports the suspended count", async () => {
    countByRoleMock.mockResolvedValue([{ role: "PILOT", total: 31 }]);
    countBySuspendedTrueMock.mockResolvedValue(3);

    const stats = await overview();

    expect(stats.usersByRole).toEqual({ DESIGNER: 0, PILOT: 31, ADMIN: 0 });
    expect(stats.suspendedUsers).toBe(3);
  });

  // Mirrors `topMissionsAreCappedAtSixAndKeepTheirOrder`.
  it("caps the top missions at six and keeps the query's order", async () => {
    topMissionsByBidsMock.mockResolvedValue([
      { name: "Orchard survey", total: 9 },
      { name: "Roof scan", total: 4 },
    ]);

    const top = (await overview()).topMissionsByBids;

    // The Java `verify(...topMissionsByBids(PageRequest.of(0, 6)))`: the cap
    // is applied in SQL, so it is the argument — not the length of the answer —
    // that has to be asserted. `PageRequest.of(0, TOP_MISSIONS)` becomes a
    // plain limit here (only the first page is ever asked for).
    expect(topMissionsByBidsMock).toHaveBeenCalledWith(6);
    // `containsExactly` — order-sensitive: the chart's bars are ranked, and the
    // ordering comes from the query, so the service must not re-sort or reverse.
    expect(top).toEqual([
      { name: "Orchard survey", bids: 9 },
      { name: "Roof scan", bids: 4 },
    ]);
  });

  /**
   * Beyond the Java suite, which cannot have this case: `mission.name` is
   * nullable in the schema (V1 never made it NOT NULL) while the chart's label
   * is a `string` in both the Angular model and the ported client type, so
   * `overview()` substitutes an empty label. Pinned here because a `null`
   * slipping through would reach the browser as a missing bar label rather
   * than an error, and because the substitution is invisible in every other
   * case above.
   */
  it("substitutes an empty label for a mission with no name", async () => {
    topMissionsByBidsMock.mockResolvedValue([{ name: null, total: 2 }]);

    expect((await overview()).topMissionsByBids).toEqual([{ name: "", bids: 2 }]);
  });
});
