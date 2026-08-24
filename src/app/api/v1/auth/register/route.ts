import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { registerSchema } from "@/features/auth/server/auth.schema";
import { createUser } from "@/features/auth/server/auth.service";
import { toUserResponse } from "@/features/users/server/user.mapper";
import type { UserResponse } from "@/features/users/user.types";

/**
 * `POST /api/v1/auth/register` — self-registration (replaces
 * `AuthController.register`). Public: `src/middleware.ts` exempts this
 * exact path from the bearer-token check, mirroring
 * `.permitAll()`/`@PreAuthorize("permitAll()")` on the source endpoint.
 *
 * SOURCE: drone-missions-backend/.../web/controller/auth/AuthController.java (`register`)
 */
export const POST = withErrorHandling(async (request) => {
  const body = await request.json();
  const { username, email, password, role } = registerSchema.parse(body);
  const user = await createUser(username, email, password, role);
  return NextResponse.json<UserResponse>(toUserResponse(user), { status: 201 });
});
