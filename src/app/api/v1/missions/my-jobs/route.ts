import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { loadMissionResponses, type MissionResponse } from "@/features/missions/mission.mapper";
import { findAwardedTo } from "@/features/missions/mission.service";

/**
 * `GET /api/v1/missions/my-jobs` — the calling pilot's awarded missions, their
 * "jobs" (replaces `MissionController.findMyJobs`).
 *
 * The pilot-side counterpart of `/my-missions`, and deliberately stricter than
 * it: the source guards this one with `@PreAuthorize("hasRole('PILOT')")`
 * rather than `isAuthenticated()`, so a designer asking for their jobs gets a
 * 403 here where they would get an empty list from `/my-missions`. That
 * asymmetry is the source's, and it is mirrored rather than smoothed over.
 *
 * No visibility filter is applied, exactly as in the source: the awarded pilot
 * is one of the two people `MissionService.isVisibleTo` lets past
 * unconditionally, so a job stays on this list once it leaves the open
 * marketplace — through IN_PROGRESS, COMPLETED and CANCELLED, and even while
 * the mission is hidden from the feed by moderation. Reading the list never
 * advances a mission's status (see `mission.service.ts`'s header).
 *
 * The caller id comes off the headers `middleware.ts` attaches from the
 * verified token's `sub` claim — the analogue of
 * `@AuthenticationPrincipal long userId`. It is never read from the query
 * string, so this endpoint cannot be pointed at another pilot's jobs.
 *
 * `my-jobs` must stay a **static** segment: it sits beside `[id]/route.ts`, and
 * it is App Router's static-beats-dynamic precedence that keeps `/my-jobs` from
 * being parsed as a mission id. Turning it into a dynamic or catch-all segment
 * would silently route these requests to the detail handler instead — the
 * route tests import this handler directly and would not notice, so the guard
 * against that regression is `e2e/lifecycle.spec.ts`, which drives the real
 * URL.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java (`findMyJobs`)
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  requireRole(caller, "PILOT");

  const missions = await findAwardedTo(caller.id);
  return NextResponse.json<MissionResponse[]>(await loadMissionResponses(missions));
});
