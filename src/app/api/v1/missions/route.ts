import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import {
  loadMissionResponse,
  loadMissionResponses,
  toMissionDraft,
  type MissionResponse,
} from "@/features/missions/server/mission.mapper";
import { missionRequestSchema, openMissionQuerySchema } from "@/features/missions/server/mission.schema";
import { create, findOpen } from "@/features/missions/server/mission.service";

/**
 * `POST /api/v1/missions` + `GET /api/v1/missions` (replace
 * `MissionController.create` and `MissionController.findAll`).
 *
 * Both are authenticated: neither path is in `src/middleware.ts`'s
 * `PUBLIC_PATHS`, so an anonymous request is already rejected with 401 before
 * either handler runs — which is what `@PreAuthorize("isAuthenticated()")` on
 * `findAll` amounts to. `create`'s stricter
 * `@PreAuthorize("hasRole('DESIGNER')")` becomes an explicit `requireRole()`
 * call, the only authorization rule these two endpoints carry (mission
 * *ownership* is enforced in the service layer, where the mission is loaded).
 *
 * The admin listing `GET /api/v1/missions/all` is Phase 7 and deliberately
 * absent; adding it here now would mean porting `searchAll` blind.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java
 * (`create`, `findAll`), test .../web/controller/mission/MissionControllerTest.java
 */

/**
 * Creates a mission owned by the calling designer.
 *
 * The role check runs *after* the body is validated, matching the source's
 * ordering rather than reversing it: in Spring MVC the `@Valid` argument
 * resolution happens while the handler method's arguments are being resolved,
 * before the method-security advice around the controller bean evaluates
 * `@PreAuthorize` — so a pilot posting an invalid flight plan gets the same
 * 400 there that it gets here, not a 403. Nothing observable happens before
 * the check: parsing is pure, and every write is behind it.
 */
export const POST = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  const body = await request.json();
  const draft = toMissionDraft(missionRequestSchema.parse(body));
  requireRole(caller, "DESIGNER");

  const created = await create(draft, caller.id);
  return NextResponse.json<MissionResponse>(await loadMissionResponse(created), {
    status: 201,
    // `ServletUriComponentsBuilder.fromCurrentRequest().path("/{id}")` — the
    // request's own URL with the new id appended, so a relocated deployment
    // (or a different host header) still returns a correct absolute URL.
    headers: { location: createdLocation(request.url, created.id) },
  });
});

/** The `Location` header for a freshly created mission: this request's URL + `/{id}`. */
function createdLocation(requestUrl: string, id: number): string {
  const location = new URL(requestUrl);
  location.pathname = `${location.pathname.replace(/\/+$/, "")}/${id}`;
  return location.toString();
}

/**
 * The open marketplace — every mission currently on offer, newest first,
 * narrowed by the optional `location` / `keyword` / `date` filters. Mirrors
 * `MissionController.findAll`.
 *
 * The filters are passed through verbatim: normalising them (trim, lowercase,
 * blank -> null) is `MissionService.findOpen`'s job, because that
 * normalisation is what keeps two case-different searches for the same thing
 * from becoming two distinct list-cache entries.
 */
export const GET = withErrorHandling(async (request) => {
  const params = new URL(request.url).searchParams;
  const { location, keyword, date } = openMissionQuerySchema.parse({
    location: params.get("location"),
    keyword: params.get("keyword"),
    date: params.get("date"),
  });

  const missions = await findOpen(location, keyword, date);
  return NextResponse.json<MissionResponse[]>(await loadMissionResponses(missions));
});
