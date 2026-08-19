import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";

/**
 * `POST /api/v1/auth/logout` (replaces `AuthController.logout`).
 * Authenticated-only: this path is not in `src/middleware.ts`'s
 * `PUBLIC_PATHS`, so an anonymous request is already rejected with 401
 * before this handler ever runs — mirroring `@PreAuthorize("isAuthenticated()")`.
 *
 * Logout is a client-side concern for stateless JWTs: the client simply
 * discards the token. This endpoint exists for API symmetry and does
 * nothing server-side, returning 204 (server-side invalidation would
 * require a token blacklist, which the source doesn't implement either).
 *
 * SOURCE: drone-missions-backend/.../web/controller/auth/AuthController.java (`logout`)
 */
export const POST = withErrorHandling(async () => {
  return new NextResponse(null, { status: 204 });
});
