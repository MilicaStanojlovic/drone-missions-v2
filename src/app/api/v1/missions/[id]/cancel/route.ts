import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { loadMissionResponse, type MissionResponse } from "@/features/missions/mission.mapper";
import { cancel } from "@/features/missions/mission.service";

/**
 * `POST /api/v1/missions/{id}/cancel` — the mission's creator calls it off
 * (replaces `MissionController.cancel`).
 *
 * `@PreAuthorize("hasRole('DESIGNER')")` becomes an explicit `requireRole()`;
 * *which* designer may cancel is a property of the mission, so ownership is
 * checked in `MissionService.cancel` (`MissionAccessDeniedError` -> 403), and
 * an already-finished or already-cancelled mission is
 * `MissionConflictError` -> 409 ("cannot be cancelled from status X").
 *
 * The cascade the call performs — every outstanding bid (PENDING *and* the
 * winner's ACCEPTED one) rejected in the same transaction, and the awarded
 * pilot notified and emailed — is invisible from here by design: the source
 * returns only the cancelled mission, so this responds **200 with the single
 * `MissionResponse`**, not the rejected bid list.
 *
 * There is no request body: the mission id in the path is the whole input, and
 * the cancelling designer comes off the headers `middleware.ts` attaches from
 * the verified token's `sub` claim (the analogue of
 * `@AuthenticationPrincipal long userId`), never from the body or query
 * string, so a cancellation cannot be attributed to another designer.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java (`cancel`)
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
  requireRole(caller, "DESIGNER");

  const mission = await cancel(id, caller.id);
  return NextResponse.json<MissionResponse>(await loadMissionResponse(mission));
});
