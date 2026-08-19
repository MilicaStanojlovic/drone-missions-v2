import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { toUserResponse } from "@/features/users/user.mapper";
import { suspend } from "@/features/users/user.service";
import type { UserResponse } from "@/features/users/user.types";

/**
 * `POST /api/v1/users/{id}/suspend` — moderation blocks an account from
 * designing, bidding, being awarded work or executing it (replaces
 * `UserController.suspend`).
 *
 * `@PreAuthorize("hasRole('ADMIN')")` becomes an explicit `requireRole()`. The
 * two rules that are *not* the web layer's stay in `user.service.ts`, and both
 * surface here only as the status they map to: an ADMIN target is
 * `AdminCannotBeSuspendedError` -> 409, an unknown id `UserNotFoundError` ->
 * 404.
 *
 * Responds **200 with the full `UserResponse`** — including for the idempotent
 * re-suspend, which writes nothing and audits nothing but still answers with
 * the account's current state, so the admin table can re-render from the
 * response either way.
 *
 * There is no request body: the target comes from the path and the acting admin
 * off the headers `middleware.ts` attaches from the verified token's `sub`
 * claim (the analogue of `@AuthenticationPrincipal long userId`), never from
 * the body or query string — so a suspension can never be attributed to
 * another admin in the audit trail.
 *
 * SOURCE: drone-missions-backend/.../web/controller/user/UserController.java (`suspend`)
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

  const user = await suspend(id, caller.id);
  return NextResponse.json<UserResponse>(toUserResponse(user));
});
