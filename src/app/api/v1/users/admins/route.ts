import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { newAdminSchema } from "@/features/auth/auth.schema";
import { createAdmin } from "@/features/auth/auth.service";
import { toUserResponse } from "@/features/users/user.mapper";
import type { UserResponse } from "@/features/users/user.types";

/**
 * `POST /api/v1/users/admins` — an admin registers another admin (replaces
 * `UserController.createAdmin`). As the source puts it, "the only path that can
 * mint one at runtime": `/api/v1/auth/register` refuses the ADMIN role
 * outright, so this endpoint and the V12 seed migration are the only two ways
 * an admin account comes into existence.
 *
 * `@PreAuthorize("hasRole('ADMIN')")` becomes an explicit `requireRole()`, and
 * it is what makes the service's missing role check safe — `createAdmin` takes
 * no role argument and always mints ADMIN, so this guard is the whole
 * privilege boundary. It also sits on a **static** segment beside the dynamic
 * `users/[id]`; Next.js resolves static segments first, so `/users/admins`
 * never reaches the `[id]` handler as the id `"admins"`.
 *
 * The creating admin comes off the headers `middleware.ts` attaches from the
 * verified token (the analogue of `@AuthenticationPrincipal long userId`),
 * never from the body — so the `ADMIN_CREATED` audit row can never be
 * attributed to a different admin than the one who actually called.
 *
 * Answers **201 Created** with the full `UserResponse`, email included, like
 * every other admin-facing user response in this phase; the mapper whitelists
 * fields, so the new account's password hash cannot travel back out.
 *
 * SOURCE: drone-missions-backend/.../web/controller/user/UserController.java (`createAdmin`),
 * test .../web/controller/user/UserControllerTest.java (`createAdminPassesThePrincipalAndReturns201`)
 */
export const POST = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  requireRole(caller, "ADMIN");

  // KNOWN DIVERGENCE — body parsing follows the guard here, unlike the query
  // parsing in `users/route.ts` which precedes it. In the source both orderings
  // are the same one: `@Valid @RequestBody` is resolved and validated during
  // argument resolution, which `InvocableHandlerMethod` performs *before*
  // invoking the security-advised controller bean, so Spring answers a
  // non-admin who also sends a malformed body **400**, where this handler
  // answers **403**. The divergence is deliberate and unobservable in practice:
  // either way the request is rejected and nothing is written, no client sends
  // a body to an endpoint it may not call, and checking first means an
  // unauthorized caller's payload is never even read off the wire. The query
  // parsing in the listing endpoints is ordered the other way *because* there
  // the status is observable — `?role=nonsense` is a 400 in the source whoever
  // asks, and no payload is consumed to find that out.
  const body = await request.json();
  const { username, email, password } = newAdminSchema.parse(body);

  const user = await createAdmin(username, email, password, caller.id);
  return NextResponse.json<UserResponse>(toUserResponse(user), { status: 201 });
});
