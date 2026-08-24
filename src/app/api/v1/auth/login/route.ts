import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { loginSchema } from "@/features/auth/server/auth.schema";
import { login } from "@/features/auth/server/auth.service";
import { toUserResponse } from "@/features/users/server/user.mapper";
import type { UserResponse } from "@/features/users/user.types";

/**
 * `POST /api/v1/auth/login` (replaces `AuthController.login`). Public:
 * `src/middleware.ts` exempts this exact path from the bearer-token check,
 * mirroring `.permitAll()` on the source endpoint.
 *
 * On success the JWT is returned in the `Authorization` response header (as
 * `Bearer <token>`) and the authenticated user's profile in the body —
 * exactly what the source controller does and what the Angular client's
 * `auth.service.ts` reads the token back out of.
 *
 * SOURCE: drone-missions-backend/.../web/controller/auth/AuthController.java (`login`)
 */
export const POST = withErrorHandling(async (request) => {
  const body = await request.json();
  const { email, password } = loginSchema.parse(body);
  const { token, user } = await login(email, password);
  return NextResponse.json<UserResponse>(toUserResponse(user), {
    status: 200,
    headers: { Authorization: `Bearer ${token}` },
  });
});
