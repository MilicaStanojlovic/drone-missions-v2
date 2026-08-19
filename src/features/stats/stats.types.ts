import "server-only";
import type { MissionStatus, UserRole } from "@/db/schema";

/**
 * The platform-stats value object — the one shape the admin overview is
 * counted into (replaces `business.service.stats.PlatformStats`).
 *
 * Two Java types collapse into one here. The source has a business record
 * (`PlatformStats`, returned by `PlatformStatsService`) and a web DTO
 * (`PlatformStatsResponse`, produced from it by the trivial
 * `PlatformStatsMapper`) whose components are field-for-field identical — the
 * mapper only re-wraps the maps and the `TopMission` list. In this port the
 * two are the same TypeScript shape, so keeping two declarations would buy
 * nothing but a place for them to drift; the route serializes the service's
 * value directly.
 *
 * This module is where that shape is declared, and `stats.client.ts`
 * re-exports it (`import type` is erased at compile time, so the browser
 * bundle never pulls in this `server-only` module) — the same direction
 * `audit.types.ts` → `audit.client.ts` and `rating.queries.ts`'s
 * `RatingSummary` → `rating.client.ts` already run: one server-side
 * declaration, the client deriving from it rather than transcribing it. Until
 * Phase 9 there was no server half at all, which is why the shape was
 * originally written down in `stats.client.ts` (its header says so, and says
 * this phase should type its response against it rather than invent a second
 * one).
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/stats/PlatformStats.java
 * - drone-missions-backend/.../web/dto/stats/PlatformStatsResponse.java
 * - drone-missions-frontend/.../models/stats.model.ts
 */

/**
 * One bar of the overview's bids-per-mission chart — name only, never an id,
 * as the source's javadoc insists. Mirrors `PlatformStats.TopMission` and its
 * DTO twin `PlatformStatsResponse.TopMissionResponse`.
 *
 * `bids` is the row's bid count (the query layer calls the same number
 * `total`, after the `MissionBidCount` projection it mirrors).
 */
export interface TopMission {
  name: string;
  bids: number;
}

/**
 * Platform-wide snapshot counts for the admin overview.
 *
 * Both maps carry **every** status/role, zero-filled — a `Record`, not a
 * `Partial<Record>` — which is what lets the overview index them without a
 * fallback and never have to guess whether a missing key means zero or an
 * error. The zero-filling is the service's job (`overview()`); the queries
 * behind it answer sparsely, exactly as the SQL groups.
 *
 * Every count is a `number` where the source has `long`/`BigDecimal`: none of
 * these can approach 2^53, and Jackson writes both as JSON numbers anyway, so
 * this is the shape that arrives over the wire either way.
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
