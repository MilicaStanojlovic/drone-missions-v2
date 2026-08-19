import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import {
  loadMissionResponse,
  toMissionDraft,
  type MissionResponse,
} from "@/features/missions/mission.mapper";
import { missionRequestSchema } from "@/features/missions/mission.schema";
import { deleteMission, findById, update } from "@/features/missions/mission.service";

/**
 * `GET` / `PUT` / `DELETE /api/v1/missions/{id}` (replace
 * `MissionController.findById`, `update` and `delete`).
 *
 * Authorization is split exactly as in the source, and the split matters:
 *
 * - **Role** (`@PreAuthorize("hasRole('DESIGNER')")` on `update`/`delete`) is
 *   a property of the endpoint, so it is checked here, in the handler.
 * - **Ownership** is a property of the mission, so it lives in the service,
 *   which is the layer that loads the row — `MissionAccessDeniedError` -> 403
 *   for someone else's mission (`MissionAccessDeniedException` parity).
 * - **Visibility** on `GET` is also the service's: a mission the caller may
 *   not see raises `MissionNotFoundError` -> 404, never a 403, so the status
 *   itself cannot confirm that a hidden mission exists.
 *
 * `GET` is authenticated-only (`@PreAuthorize("isAuthenticated()")`), which
 * `src/middleware.ts` already enforces for this path — any role may read a
 * mission that is visible to them.
 *
 * The lifecycle and moderation sub-routes (`/start`, `/complete`, `/cancel`,
 * `/hide`, `/unhide`, `/remove`) are Phases 5 and 7.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java
 * (`findById`, `update`, `delete`), test .../web/controller/mission/MissionControllerTest.java
 */

/** The dynamic segment this route file owns. */
type MissionRouteContext = { params: Promise<{ id: string }> };

/**
 * The path variable, validated the way `@PathVariable Long id` is: Spring
 * converts it and answers 400 (`MethodArgumentTypeMismatchException`) when the
 * segment is not a number. Parsing it through Zod puts that same rejection on
 * `withErrorHandling()`'s validation branch, which is the mechanism this port
 * uses for every bad parameter (see the handler's doc comment).
 *
 * The safe-integer bound is the JS counterpart of `Long`'s range: an id past
 * `2^53 - 1` cannot round-trip through a JS number, and the row it would name
 * cannot exist (the column is an identity `bigint` that starts at 1), so
 * rejecting it beats querying for a silently rounded id.
 */
const missionIdSchema = z.object({
  id: z
    .string()
    .regex(/^-?\d+$/, "must be a number")
    .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
    .transform(Number),
});

/**
 * Parses `{id}` out of the matched route segment. Wrapped in an object schema
 * so the rejection reaches the client keyed as `id` — the closest equivalent
 * of the source's `Invalid value for parameter 'id'`.
 */
async function missionId(context: MissionRouteContext): Promise<number> {
  return missionIdSchema.parse(await context.params).id;
}

/**
 * One mission, if the caller is allowed to see it. Mirrors
 * `MissionController.findById`; an invisible mission is a 404 from the service
 * (see `MissionService.isVisibleTo`).
 */
export const GET = withErrorHandling<MissionRouteContext>(async (request, context) => {
  const id = await missionId(context);
  const caller = getCurrentUser(request);

  const mission = await findById(id, caller.id);
  return NextResponse.json<MissionResponse>(await loadMissionResponse(mission));
});

/**
 * Applies the owner's edit. Mirrors `MissionController.update`.
 *
 * The body is validated before the role check for the same reason as on
 * `POST /api/v1/missions` — Spring resolves and validates `@Valid` handler
 * arguments before the `@PreAuthorize` advice runs, so an invalid payload is a
 * 400 in both ports regardless of the caller's role.
 */
export const PUT = withErrorHandling<MissionRouteContext>(async (request, context) => {
  const id = await missionId(context);
  const caller = getCurrentUser(request);
  const body = await request.json();
  const changes = toMissionDraft(missionRequestSchema.parse(body));
  requireRole(caller, "DESIGNER");

  const updated = await update(id, changes, caller.id);
  return NextResponse.json<MissionResponse>(await loadMissionResponse(updated));
});

/**
 * Deletes the owner's mission. Mirrors `MissionController.delete`: 204 with no
 * body, because the mission no longer exists to be returned.
 */
export const DELETE = withErrorHandling<MissionRouteContext>(async (request, context) => {
  const id = await missionId(context);
  const caller = getCurrentUser(request);
  requireRole(caller, "DESIGNER");

  await deleteMission(id, caller.id);
  return new NextResponse(null, { status: 204 });
});
