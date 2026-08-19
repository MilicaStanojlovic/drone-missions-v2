import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/guards";
import { findById } from "@/features/users/user.service";
import { toUserResponse } from "@/features/users/user.mapper";
import type { UserResponse } from "@/features/users/user.types";

/**
 * `GET /api/v1/users/me` (replaces `UserController.me`). Authenticated-only:
 * this path is not in `src/middleware.ts`'s `PUBLIC_PATHS`, so an anonymous
 * request is already rejected with 401 before this handler ever runs —
 * mirroring `@PreAuthorize("isAuthenticated()")`. The caller id comes off
 * the request headers `middleware.ts` attaches from the verified token's
 * `sub` claim — the Next.js analogue of `@AuthenticationPrincipal long userId`.
 *
 * A token for an id that no longer exists (e.g. the account was deleted
 * after the token was issued) surfaces `UserNotFoundError` from the service
 * layer -> 404, via `withErrorHandling()`.
 *
 * SOURCE: drone-missions-backend/.../web/controller/user/UserController.java (`me`)
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  const user = await findById(caller.id);
  return NextResponse.json<UserResponse>(toUserResponse(user), { status: 200 });
});
