import { apiFetch } from "@/features/auth/auth.client";
import { ensureOk } from "@/lib/api/client";
import type { MissionStatus, UserRole } from "@/db/schema";

/**
 * Client-side platform-stats access: the one snapshot call the admin overview
 * makes. Ports `services/platform-stats.service.ts` and `models/stats.model.ts`.
 *
 * Only the browser half lives here. The server half — `stats.queries.ts`,
 * `stats.service.ts` and the `GET /api/v1/platform-stats` route behind it — is
 * Phase 9's ("Platform stats dashboard", which depends on every data vertical,
 * see MIGRATION_PLAN.md §7). Until that lands, `fetchPlatformStats` reaches a
 * route that does not exist yet and rejects, which the overview renders as its
 * (ported) error state; nothing else in the app calls it. The types below are
 * transcribed from the backend DTO rather than derived from a local one for
 * the same reason — there is no server-side `PlatformStats` in this repo yet,
 * and Phase 9 should be able to type its response against this shape instead
 * of inventing a second one.
 *
 * `import type` for `MissionStatus`/`UserRole` is erased at compile time, so
 * this stays free of any runtime import of `@/db/schema` (which pulls in
 * `drizzle-orm/pg-core`) — the same technique `auth.client.ts` and
 * `mission.client.ts` use.
 *
 * SOURCE:
 * - drone-missions-frontend/.../services/platform-stats.service.ts
 * - drone-missions-frontend/.../models/stats.model.ts
 * - drone-missions-backend/.../web/dto/stats/PlatformStatsResponse.java
 * - drone-missions-backend/.../web/controller/stats/PlatformStatsController.java
 */

/** One bar of the bids-per-mission chart — mission name only, never an id. */
export interface TopMission {
  name: string;
  bids: number;
}

/**
 * Platform-wide snapshot counts, as `GET /api/v1/platform-stats` returns them.
 *
 * Both maps arrive zero-filled with every status/role, which is what lets the
 * overview index them without a fallback — `Record`, not `Partial<Record>`,
 * exactly as the Angular model declares them. `bidAmountTotal` is the
 * backend's `BigDecimal`, which Jackson writes as a JSON number.
 */
export interface PlatformStats {
  missionsByStatus: Record<MissionStatus, number>;
  activePilots: number;
  bidCount: number;
  bidAmountTotal: number;
  suspendedUsers: number;
  usersByRole: Record<UserRole, number>;
  topMissionsByBids: TopMission[];
}

/** One snapshot of the platform counts (admin-only endpoint). Ports `getOverview`. */
export async function fetchPlatformStats(): Promise<PlatformStats> {
  const response = await ensureOk(await apiFetch("/api/v1/platform-stats"));
  return (await response.json()) as PlatformStats;
}
