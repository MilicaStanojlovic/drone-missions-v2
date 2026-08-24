import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { toUserResponse } from "@/features/users/server/user.mapper";
import { reactivate } from "@/features/users/server/user.service";
import type { UserResponse } from "@/features/users/user.types";

/**
 * `POST /api/v1/users/{id}/reactivate` — moderation lifts a suspension
 * (replaces `UserController.reactivate`).
 *
 * The mirror image of `/suspend`, with one asymmetry inherited from the
 * source: there is no ADMIN-target rejection on this path, because an admin
 * account can never have become suspended in the first place, so reactivating
 * one is a no-op the service's idempotence check already covers (it returns the
 * account untouched, writing and auditing nothing). An unknown id is still
 * `UserNotFoundError` -> 404.
 *
 * `@PreAuthorize("hasRole('ADMIN')")` becomes an explicit `requireRole()`;
 * responds 200 with the full `UserResponse`; takes no body, with the acting
 * admin read off the headers `middleware.ts` attaches from the verified token's
 * `sub` claim.
 *
 * SOURCE: drone-missions-backend/.../web/controller/user/UserController.java (`reactivate`)
 */

/** The dynamic segment this route file owns — `users/[id]`'s, one level up. */
type UserRouteContext = { params: Promise<{ id: string }> };

/**
 * The path variable, validated the way `@PathVariable Long id` is — the same
 * schema `users/[id]/route.ts` uses, re-declared here because a `route.ts` may
 * only export route handlers.
 */
const userIdSchema = z.object({
  id: z
    .string()
    .regex(/^-?\d+$/, "must be a number")
    .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
    .transform(Number),
});

export const POST = withErrorHandling<UserRouteContext>(async (request, context) => {
  const { id } = userIdSchema.parse(await context.params);
  const caller = getCurrentUser(request);
  requireRole(caller, "ADMIN");

  const user = await reactivate(id, caller.id);
  return NextResponse.json<UserResponse>(toUserResponse(user));
});
