import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { loadMissionResponse, type MissionResponse } from "@/features/missions/mission.mapper";
import { unhide } from "@/features/missions/mission.service";

/**
 * `POST /api/v1/missions/{id}/unhide` — the mirror image of `/hide`: an admin
 * returns a mission to the marketplace, HIDDEN -> VISIBLE (replaces
 * `MissionController.unhide`).
 *
 * Same contract as `/hide` in every respect — admin-only, no body, 200 with the
 * updated `MissionResponse`, 409 when the mission is not currently in the
 * `from` state — because the source implements both through one private
 * `moderate(id, from, to)` state machine and differs only in the direction and
 * the audit action. See `hide/route.ts` for the reasoning that applies to both.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java (`unhide`)
 */

/** The dynamic segment this route file owns — `missions/[id]`'s, one level up. */
type MissionRouteContext = { params: Promise<{ id: string }> };

/**
 * The path variable, validated the way `@PathVariable Long id` is — the same
 * schema `missions/[id]/route.ts` uses, re-declared because a `route.ts` may
 * only export route handlers.
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

  const mission = await unhide(id, caller.id);
  return NextResponse.json<MissionResponse>(await loadMissionResponse(mission));
});
