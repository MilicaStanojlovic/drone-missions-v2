import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { remove } from "@/features/missions/server/mission.service";

/**
 * `POST /api/v1/missions/{id}/remove` — an admin permanently deletes a mission
 * (replaces `MissionController.remove`).
 *
 * **204 No Content**, because the mission no longer exists to be returned —
 * the one moderation endpoint that does not answer a `MissionResponse`. Its
 * bids, notifications and ratings cascade away with it (V15), so the audit row
 * `MissionService.remove` writes is all that survives.
 *
 * It is a `POST`, not a `DELETE`, and that is the source's choice rather than
 * an oversight: `DELETE /api/v1/missions/{id}` is already taken by the
 * *owner's* delete, which is designer-only and ownership-checked. Keeping the
 * admin's hard delete on its own verb+path is what lets the two carry entirely
 * different authorization without one shadowing the other.
 *
 * Admin-only via `requireRole()` (`@PreAuthorize("hasRole('ADMIN')")`), and
 * that is the only rule the web layer contributes: an admin may remove any
 * mission in any state, so the service's sole guard is existence
 * (`MissionNotFoundError` -> 404, with nothing deleted and nothing audited).
 *
 * There is no request body: the mission id in the path is the whole input, and
 * the acting admin comes off the headers `middleware.ts` attaches from the
 * verified token's `sub` claim (the analogue of
 * `@AuthenticationPrincipal long userId`), never from the body or query string
 * — so the deletion cannot be attributed to another admin in the audit trail,
 * which for a hard delete is the only record there will ever be.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java (`remove`)
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

  await remove(id, caller.id);
  return new NextResponse(null, { status: 204 });
});
