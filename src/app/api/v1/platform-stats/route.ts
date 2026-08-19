import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { overview } from "@/features/stats/stats.service";
import type { PlatformStats } from "@/features/stats/stats.types";

/**
 * `GET /api/v1/platform-stats` — the admin overview's one snapshot call
 * (replaces `PlatformStatsController.overview`).
 *
 * The thinnest handler in the app: no query params, no body, no paging. Check
 * the role, ask the service for the snapshot, serialize it.
 *
 * Admin-only. `@PreAuthorize("hasRole('ADMIN')")` becomes an explicit
 * `requireRole()` here, in the handler, because the gate is a property of the
 * *endpoint* — the same split the audit and users admin routes document, and
 * the reason `stats.service.ts` deliberately carries no role check of its own.
 * The guard runs first and unconditionally: there is nothing to parse ahead of
 * it, so unlike the listing routes there is no ordering question to answer.
 *
 * **No mapper module.** The source hands the service's `PlatformStats` record
 * to a `PlatformStatsMapper` that copies it into a `PlatformStatsResponse`
 * field for field — the two records are component-for-component identical, and
 * the mapper's only real work is re-wrapping each `TopMission` as a
 * `TopMissionResponse`. This port collapses both Java types into the single
 * `PlatformStats` interface in `stats.types.ts` (its header explains why), so
 * the service's value already *is* the wire shape and the mapping step would
 * be an identity function with a place to drift. `NextResponse.json` typed
 * against that interface is what keeps the response honest instead.
 *
 * The response therefore matches `stats.client.ts`'s `PlatformStats` exactly —
 * both maps zero-filled over every status/role by the service, and
 * `bidAmountTotal` a JSON **number**: Jackson writes the source's `BigDecimal`
 * as an unquoted number, and `volume()` has already narrowed postgres.js's
 * `sum(numeric)` decimal text to a `number` before it gets here.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/controller/stats/PlatformStatsController.java
 * - drone-missions-backend/.../web/mapper/stats/PlatformStatsMapper.java
 * - drone-missions-backend/.../web/dto/stats/PlatformStatsResponse.java
 * - test .../web/controller/stats/PlatformStatsControllerTest.java
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  requireRole(caller, "ADMIN");

  return NextResponse.json<PlatformStats>(await overview());
});
