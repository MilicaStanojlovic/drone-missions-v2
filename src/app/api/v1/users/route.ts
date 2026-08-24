import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { mapPage, parsePageRequest, toPagedModel, type PagedModel } from "@/lib/api/paging";
import { toUserResponse } from "@/features/users/server/user.mapper";
import { userListQuerySchema } from "@/features/users/server/user.schema";
import { search } from "@/features/users/server/user.service";
import type { UserResponse } from "@/features/users/user.types";

/**
 * `GET /api/v1/users` — the admin account listing (replaces
 * `UserController.all`).
 *
 * Admin-only: `@PreAuthorize("hasRole('ADMIN')")` becomes an explicit
 * `requireRole()` call here, in the handler, because it is a property of the
 * *endpoint* rather than of any one account (the same split the mission routes
 * document). The service layer deliberately carries no role check of its own —
 * see `user.service.ts`'s `search`.
 *
 * The response body is the **full** `UserResponse`, email included, and that is
 * intentional rather than an oversight of `toPublicUserResponse`: the source
 * annotates this method "Full UserResponse (with email) on purpose — this is
 * the admin view". `GET /api/v1/users/{id}`, which any authenticated caller may
 * reach, is the one that withholds it.
 *
 * SOURCE: drone-missions-backend/.../web/controller/user/UserController.java (`all`),
 * test .../web/controller/user/UserControllerTest.java
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  const params = new URL(request.url).searchParams;
  // Parsed before the role check, matching the source's ordering: Spring
  // resolves and converts `@RequestParam`/`Pageable` handler arguments in
  // `InvocableHandlerMethod` *before* the method-security advice around the
  // controller bean evaluates `@PreAuthorize`, so `?role=nonsense` is a 400
  // there whoever asks. Nothing observable happens before the check — parsing
  // is pure, and the query is behind it.
  const { role } = userListQuerySchema.parse({ role: params.get("role") });
  // `@PageableDefault(size = 20, sort = "createdAt", direction = DESC)`: the
  // size default lives here, the sort in `user.queries.ts` (see the "no `sort`"
  // note in `src/lib/api/paging.ts`).
  const pageRequest = parsePageRequest(params);
  requireRole(caller, "ADMIN");

  const page = await search(role ?? null, pageRequest);
  return NextResponse.json<PagedModel<UserResponse>>(
    // `new PagedModel<>(userService.search(role, pageable).map(mapper::toResponse))`.
    toPagedModel(mapPage(page, toUserResponse)),
  );
});
