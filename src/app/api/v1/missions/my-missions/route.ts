import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/guards";
import { loadMissionResponses, type MissionResponse } from "@/features/missions/server/mission.mapper";
import { findOwnedBy } from "@/features/missions/server/mission.service";

/**
 * `GET /api/v1/missions/my-missions` (replaces `MissionController.findMine`).
 *
 * Every mission the caller created, whatever its status or moderation —
 * a designer's own drafts and hidden missions have to stay reachable to their
 * owner. Authenticated-only (`@PreAuthorize("isAuthenticated()")`), which
 * `src/middleware.ts` already enforces for this path; deliberately *not*
 * restricted to DESIGNER, exactly as in the source — a pilot who somehow owns
 * a mission still sees it, and the empty list is the normal answer.
 *
 * The caller id comes off the request headers `middleware.ts` attaches from
 * the verified token's `sub` claim — the analogue of
 * `@AuthenticationPrincipal long userId`. It is never read from the query
 * string, so this endpoint cannot be pointed at another user's missions.
 *
 * The pilot-side counterpart (`/my-jobs`, awarded missions) is Phase 5.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java (`findMine`),
 * test .../web/controller/mission/MissionControllerTest.java
 * (`ownedMissionsAreStillReturnedForARealOwner`)
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  const missions = await findOwnedBy(caller.id);
  return NextResponse.json<MissionResponse[]>(await loadMissionResponses(missions));
});
