import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { loadMissionResponse, type MissionResponse } from "@/features/missions/server/mission.mapper";
import { hide } from "@/features/missions/server/mission.service";

/**
 * `POST /api/v1/missions/{id}/hide` — an admin takes a mission out of the
 * marketplace, VISIBLE -> HIDDEN (replaces `MissionController.hide`).
 *
 * Hiding is not deleting, which is why this answers **200 with the updated
 * `MissionResponse`** where `/remove` answers 204: the mission still exists,
 * and the admin table re-renders the row from this body. Everything the
 * transition means — the `VISIBLE` precondition (`MissionConflictError` -> 409
 * for an already hidden mission, deliberately *not* an idempotent no-op the way
 * `users/{id}/suspend` is), the audit row, the cache eviction that drops it out
 * of the feed — belongs to `MissionService.hide`.
 *
 * `@PreAuthorize("hasRole('ADMIN')")` becomes an explicit `requireRole()`, and
 * it is the only rule the web layer contributes: unlike `/cancel`, there is no
 * ownership check anywhere in this path, because moderating someone else's
 * mission is precisely what the endpoint is for.
 *
 * There is no request body: the mission id in the path is the whole input, and
 * the acting admin comes off the headers `middleware.ts` attaches from the
 * verified token's `sub` claim (the analogue of
 * `@AuthenticationPrincipal long userId`), never from the body or query string,
 * so a hide can never be attributed to another admin in the audit trail.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java (`hide`)
 */

/** The dynamic segment this route file owns — `missions/[id]`'s, one level up. */
type MissionRouteContext = { params: Promise<{ id: string }> };

/**
 * The path variable, validated the way `@PathVariable Long id` is — the same
 * schema `missions/[id]/route.ts` uses, for the same reasons, re-declared
 * because a `route.ts` may only export route handlers.
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
  requireRole(caller, "ADMIN");

  const mission = await hide(id, caller.id);
  return NextResponse.json<MissionResponse>(await loadMissionResponse(mission));
});
