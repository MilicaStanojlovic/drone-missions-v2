import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { loadMissionResponse, type MissionResponse } from "@/features/missions/server/mission.mapper";
import { complete } from "@/features/missions/server/mission.service";

/**
 * `POST /api/v1/missions/{id}/complete` — the awarded pilot marks the work
 * finished, moving the mission IN_PROGRESS -> COMPLETED (replaces
 * `MissionController.complete`).
 *
 * The exact shape of its sibling `/start`: `@PreAuthorize("hasRole('PILOT')")`
 * becomes `requireRole()`, and every mission-scoped rule stays in
 * `MissionService.complete` — awarded pilot only
 * (`MissionAccessDeniedError` -> 403), not suspended (`UserSuspendedError` ->
 * 403), and IN_PROGRESS only (`MissionConflictError` -> 409, "cannot be
 * completed from status X"). The status guard is what makes a mission
 * un-completable twice, and un-completable before it was ever started.
 *
 * Like `start`, this raises neither a notification nor an email: the source
 * announces only cancellation, whose loser is a pilot who was counting on the
 * work. The designer learns of a completion from the mission itself.
 *
 * There is no request body: the mission id in the path is the whole input, and
 * the acting pilot comes off the headers `middleware.ts` attaches from the
 * verified token's `sub` claim (the analogue of
 * `@AuthenticationPrincipal long userId`).
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java (`complete`)
 */

/** The dynamic segment this route file owns — `missions/[id]`'s, one level up. */
type MissionRouteContext = { params: Promise<{ id: string }> };

/**
 * The path variable, validated the way `@PathVariable Long id` is — the same
 * schema `missions/[id]/route.ts` uses, re-declared here because a `route.ts`
 * may only export route handlers.
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

  const mission = await complete(id, caller.id);
  return NextResponse.json<MissionResponse>(await loadMissionResponse(mission));
});
