import "server-only";
import { MISSION_STATUSES, USER_ROLES, type MissionStatus, type UserRole } from "@/db/schema";
import { topMissionsByBids, volume } from "@/features/bids/bid.queries";
import { getMissionDao } from "@/features/missions/mission.cache";
import {
  countByRole,
  countByRoleAndSuspendedFalse,
  countBySuspendedTrue,
} from "@/features/users/user.queries";
import type { PlatformStats, TopMission } from "@/features/stats/stats.types";

/**
 * Platform statistics service (replaces
 * `business.service.stats.PlatformStatsService`).
 *
 * One function, one job: fold the six aggregates the admin overview needs into
 * a single snapshot. All the counting happens in SQL — this module owns only
 * the zero-filling and the chart's cap.
 *
 * The aggregates live in the feature that owns each table
 * (`bid.queries.ts`, `user.queries.ts`, `mission.queries.ts` behind the
 * mission DAO) rather than in a `stats.queries.ts` of their own, mirroring the
 * source, where `PlatformStatsService` is wired with `BidRepository`,
 * `UserRepository` and `MissionDao` and has no repository of its own.
 *
 * No `requireRole()` here: the source gates the endpoint at the controller
 * (`@PreAuthorize("hasRole('ADMIN')")` on `PlatformStatsController.overview`),
 * and this port keeps the gate at the same layer — the route handler — exactly
 * as the audit and user read services do.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/stats/PlatformStatsService.java
 * - drone-missions-backend/.../business/service/stats/PlatformStats.java
 * - test .../business/service/stats/PlatformStatsServiceTest.java
 */

/** The overview's bids-per-mission chart shows at most this many bars. */
const TOP_MISSIONS = 6;

/**
 * The whole platform in one snapshot.
 *
 * The repository aggregates are sparse; every status and role is presented,
 * zero-filled, so the overview never has to guess whether a missing key means
 * zero or an error — the source's own words, and the reason the two maps are
 * built here rather than in the queries.
 *
 * Seeding from `MISSION_STATUSES` / `USER_ROLES` before folding the rows in
 * also fixes the key order to the declaration order of the union, which is
 * what the source's `EnumMap` gives it; a status that *does* have rows keeps
 * its seeded position rather than jumping to the front of the JSON object.
 *
 * The reads stay sequential, in the source's evaluation order (statuses,
 * roles, top missions, volume, active pilots, suspended), rather than being
 * raced with `Promise.all` — the same call this port already makes for the
 * pair in `ratings/user/[userId]/route.ts`. They are independent statements on
 * one pool either way, and neither form is a consistent snapshot: there is no
 * transaction here, exactly as there is none in the source (`overview()` is
 * not `@Transactional`), so a write landing mid-read can be visible to some
 * counts and not others in both languages.
 */
export async function overview(): Promise<PlatformStats> {
  // `missionDao.countByStatus()`, not `mission.queries.ts` directly: the
  // service depends on the DAO like every other mission consumer, and the
  // decorator passes this one straight through uncached (see mission.cache.ts).
  const missionsByStatus = zeroFilled(MISSION_STATUSES);
  Object.assign(missionsByStatus, await getMissionDao().countByStatus());

  const usersByRole = zeroFilled(USER_ROLES);
  for (const row of await countByRole()) {
    usersByRole[row.role] = row.total;
  }

  // `PageRequest.of(0, TOP_MISSIONS)` in the source — the query layer takes
  // the cap as a plain limit, since only the first page is ever asked for.
  const top = await topMissionsByBids(TOP_MISSIONS);
  const topMissions: TopMission[] = top.map((row) => ({
    // `mission.name` is nullable in the schema (V1 never made it NOT NULL),
    // while this chart's label is a `string` — in both the Angular model and
    // the ported client type. An empty label stands in for the null the DTO
    // could theoretically carry, the same substitution `bid.service.ts` makes
    // when a nullable mission name has to satisfy a non-null consumer. No
    // mission created through this app can reach it: the create/update schemas
    // require a name.
    name: row.name ?? "",
    bids: row.total,
  }));

  const bids = await volume();
  // Read in the order the source's constructor call evaluates its arguments.
  const activePilots = await countByRoleAndSuspendedFalse("PILOT");
  const suspendedUsers = await countBySuspendedTrue();

  return {
    missionsByStatus,
    activePilots,
    bidCount: bids.count,
    bidAmountTotal: bids.totalAmount,
    suspendedUsers,
    usersByRole,
    topMissionsByBids: topMissions,
  };
}

/**
 * A count map over every member of a string-literal union, all zero — the port
 * of seeding an `EnumMap` from `values()` before `putAll`-ing the sparse rows
 * over it.
 */
function zeroFilled<K extends MissionStatus | UserRole>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}
