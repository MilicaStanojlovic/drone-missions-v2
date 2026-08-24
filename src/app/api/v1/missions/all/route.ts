import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { parsePageRequest, toPagedModel, type PagedModel } from "@/lib/api/paging";
import { loadMissionResponses, type MissionResponse } from "@/features/missions/server/mission.mapper";
import { searchAll } from "@/features/missions/server/mission.service";

/**
 * `GET /api/v1/missions/all` — the admin moderation listing (replaces
 * `MissionController.adminList`).
 *
 * The counterpart of `GET /api/v1/missions`, and the difference is the whole
 * point of having two endpoints: the feed shows what is *on offer* (open
 * statuses, VISIBLE only, unpaged), while this shows **every** mission there
 * is — hidden ones, cancelled ones, completed ones, ownerless legacy ones —
 * paged and newest-created first, because it is the table an admin moderates
 * from. Filtering is a single `?q` matched against the mission name *or* the
 * designer's username; the normalisation (blank -> "everything", otherwise a
 * lowercase `%…%` pattern) belongs to `MissionService.searchAll` and is left
 * there, so the raw parameter travels through this handler untouched.
 *
 * Admin-only: `@PreAuthorize("hasRole('ADMIN')")` becomes an explicit
 * `requireRole()` here, in the handler, because it is a property of the
 * *endpoint* rather than of any one mission — the same split the rest of the
 * mission routes document. `searchAll` deliberately carries no role check of
 * its own.
 *
 * SOURCE: drone-missions-backend/.../web/controller/mission/MissionController.java
 * (`adminList`, `toResponses`, `ratingOf`), test
 * .../web/controller/mission/MissionControllerTest.java
 * (`adminListWrapsThePageAndSurvivesAMissionWithNoOwner`)
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  const params = new URL(request.url).searchParams;
  // Parsed before the role check, matching the source's ordering: Spring
  // resolves `@RequestParam`/`Pageable` handler arguments before the
  // method-security advice around the controller bean evaluates
  // `@PreAuthorize`. Nothing observable happens before the check — parsing is
  // pure and the query is behind it.
  const q = params.get("q");
  // `@PageableDefault(size = 20, sort = "createdAt", direction = DESC)`: the
  // size default lives here, the sort in `mission.queries.ts` (see the
  // "no `sort`" note in `src/lib/api/paging.ts`).
  const pageRequest = parsePageRequest(params);
  requireRole(caller, "ADMIN");

  const page = await searchAll(q, pageRequest);
  return NextResponse.json<PagedModel<MissionResponse>>(
    toPagedModel({
      // `page.map(m -> mapper.toResponse(m, ratingOf(ratings, m.getDesignerId())))`
      // preceded by the controller's single `ratingService.summariesFor(...)`
      // call: `loadMissionResponses` is that pair, so a page of 20 cards costs
      // one aggregate rating query rather than 20 (and answers `NONE` for the
      // ownerless missions whose ids never reach the query — the case the
      // source's controller test pins).
      content: await loadMissionResponses(page.content),
      request: page.request,
      totalElements: page.totalElements,
    }),
  );
});
