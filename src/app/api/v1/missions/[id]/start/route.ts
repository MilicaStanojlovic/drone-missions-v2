import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { loadMissionResponse, type MissionResponse } from "@/features/missions/mission.mapper";
import { start } from "@/features/missions/mission.service";

/**
 * `POST /api/v1/missions/{id}/start` — the awarded pilot begins the work,
 * moving the mission AWARDED -> IN_PROGRESS (replaces `MissionController.start`).
 *
 * `@PreAuthorize("hasRole('PILOT')")` becomes an explicit `requireRole()`, and
 * it is the only rule the web layer contributes. *Which* pilot may start the
 * mission is a property of the mission, not of the endpoint, so that check
 * lives in `MissionService.start`, the layer that loads the row — it surfaces
 * as `MissionAccessDeniedError` -> 403 for anyone who is not the awarded
 * pilot, `UserSuspendedError` -> 403 for a suspended one, and
 * `MissionConflictError` -> 409 ("cannot be started from status X") for a
 * mission that was never awarded or is already underway.
 *
 * Starting is a deliberate action: nothing in this port ever promotes a
 * mission to IN_PROGRESS on read, however long ago its `startTime` passed
 * (see `mission.service.ts`'s header — the phase spec claimed otherwise and
 * the Spring source does not).
 *
 * There is no request body: the mission id in the path is the whole input,
 * and the acting pilot comes off the headers `middleware.ts` attaches from the
 * verified token's `sub` claim (the analogue of
 * `@AuthenticationPrincipal long userId`), never from the body or query
 * string, so the start cannot be attributed to another pilot.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java (`start`)
 */

/** The dynamic segment this route file owns — `missions/[id]`'s, one level up. */
type MissionRouteContext = { params: Promise<{ id: string }> };

/**
 * The path variable, validated the way `@PathVariable Long id` is — the same
 * schema `missions/[id]/route.ts` uses, for the same reasons: Spring answers
 * 400 (`MethodArgumentTypeMismatchException`) for a non-numeric segment, and
 * the safe-integer bound rejects ids a JS number cannot represent exactly
 * (which no `bigint` identity row can have anyway) instead of querying for a
 * silently rounded one. It is re-declared rather than imported because a
 * `route.ts` may only export route handlers.
 */
const missionIdSchema = z.object({
  id: z
    .string()
    .regex(/^-?\d+$/, "must be a number")
    .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
    .transform(Number),
});

export const POST = withErrorHandling<MissionRouteContext>(async (request, context) => {
  const { id } = missionIdSchema.parse(await context.params);
  const caller = getCurrentUser(request);
  requireRole(caller, "PILOT");

  const mission = await start(id, caller.id);
  return NextResponse.json<MissionResponse>(await loadMissionResponse(mission));
});
