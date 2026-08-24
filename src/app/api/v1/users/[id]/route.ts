import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { toPublicUserResponse } from "@/features/users/server/user.mapper";
import { findById } from "@/features/users/server/user.service";
import type { PublicUserResponse } from "@/features/users/user.types";

/**
 * `GET /api/v1/users/{id}` — the public view of another account, which the
 * profile page behind a rating renders (replaces `UserController.byId`).
 *
 * Authenticated-only (`@PreAuthorize("isAuthenticated()")`), and *not*
 * admin-only: any signed-in caller may look up any account. This path is not in
 * `src/middleware.ts`'s `PUBLIC_PATHS`, so an anonymous request is already a
 * 401 before this handler runs — which is exactly what that annotation
 * amounts to. There is consequently no `getCurrentUser()` call here: the source
 * takes no principal on this method either, since the answer does not depend on
 * who is asking.
 *
 * What makes it safe to hand to any caller is the *shape*:
 * `toPublicUserResponse` drops the email (and the suspension flag), so the
 * endpoint discloses only what `PublicUserResponse` declares. An unknown id is
 * `UserNotFoundError` -> 404 from the service.
 *
 * Note the routing precedence this file sits under: `users/me/route.ts` and
 * (next task) `users/admins/route.ts` are static segments, which the App Router
 * matches ahead of this dynamic one, so `/api/v1/users/me` never arrives here
 * as an id of `"me"`.
 *
 * SOURCE: drone-missions-backend/.../web/controller/user/UserController.java (`byId`)
 */

/** The dynamic segment this route file owns. */
type UserRouteContext = { params: Promise<{ id: string }> };

/**
 * The path variable, validated the way `@PathVariable Long id` is: Spring
 * converts it and answers 400 (`MethodArgumentTypeMismatchException`) when the
 * segment is not a number. The same schema every `[id]` route in this port
 * declares — re-declared per file because a `route.ts` may only export route
 * handlers.
 */
const userIdSchema = z.object({
  id: z
    .string()
    .regex(/^-?\d+$/, "must be a number")
    .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
    .transform(Number),
});

export const GET = withErrorHandling<UserRouteContext>(async (_request, context) => {
  const { id } = userIdSchema.parse(await context.params);

  const user = await findById(id);
  return NextResponse.json<PublicUserResponse>(toPublicUserResponse(user));
});
