import "server-only";
import type { UserRole } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";

/**
 * Request-scoped auth guards (replaces reading the authenticated principal
 * via `UserPrincipal`/`Authentication` + denying with `@PreAuthorize`).
 *
 * `src/middleware.ts` verifies the bearer token once per request and
 * attaches the id/role it carries onto two request headers before the
 * request reaches a route handler (this module owns the header names, since
 * both `middleware.ts` and every route/service that calls `getCurrentUser()`
 * need to agree on them). `getCurrentUser()` reads them back out here;
 * `requireRole()` is the drop-in replacement for a controller method's
 * `@PreAuthorize("hasRole('...')")` annotation — enforced from inside the
 * service layer instead of by Spring Security AOP.
 *
 * SOURCE:
 * - drone-missions-backend/.../config/SecurityConfig.java (jwtAuthenticationConverter)
 * - drone-missions-backend/.../security/UserPrincipal.java
 */

/** Header `middleware.ts` sets from the verified token's `sub` claim (the user id). */
export const USER_ID_HEADER = "x-user-id";
/** Header `middleware.ts` sets from the verified token's `role` claim. */
export const USER_ROLE_HEADER = "x-user-role";

/** The authenticated caller's id + role — the Next.js analogue of `UserPrincipal`. */
export interface CurrentUser {
  id: number;
  role: UserRole;
}

/**
 * Reads the caller's id + role off the headers `middleware.ts` attaches to
 * every authenticated `/api/v1/**` request. Mirrors deriving the principal
 * from the JWT's `sub` (-> id) and `role` claims in
 * `jwtAuthenticationConverter()`.
 *
 * Every route this is called from sits behind `middleware.ts`'s Bearer-token
 * check (see its `config.matcher`), so in real traffic the headers are
 * always present — a missing header here is a wiring bug (a protected route
 * handler that somehow ran without going through the middleware), not a
 * legitimate "anonymous caller" outcome. Anonymous callers are already
 * turned into a 401 by the middleware itself, before any route handler
 * runs. That's why this throws a plain `Error` rather than an `AppError`:
 * it surfaces as a 500 via `withErrorHandling()` — a loud signal of the
 * wiring bug — instead of a misleading 401/403.
 */
export function getCurrentUser(request: Request): CurrentUser {
  const id = request.headers.get(USER_ID_HEADER);
  const role = request.headers.get(USER_ROLE_HEADER);
  if (!id || !role) {
    throw new Error(
      "getCurrentUser() called with no authentication context on the request " +
        "— this route is not running behind middleware.ts's Bearer-token check",
    );
  }
  return { id: Number(id), role: role as UserRole };
}

/**
 * Thrown by `requireRole()` — the direct replacement for a denied
 * `@PreAuthorize("hasRole('...')")` check. Message matches
 * `GlobalExceptionHandler.handleAuthorizationDenied`'s response body for a
 * Spring Security `AuthorizationDeniedException` (the method-security
 * denial `@PreAuthorize` throws), since `requireRole()` now enforces that
 * same rule in the service layer instead.
 */
export class RoleNotAllowedError extends ForbiddenError {
  constructor() {
    super("You do not have permission to perform this action");
  }
}

/**
 * Requires the caller to hold exactly the given role, mirroring a
 * `@PreAuthorize("hasRole('...')")` annotation on the source controller
 * method. Every such check in the source is single-role (see
 * `AuthController`/`BidController`/`MissionController`/`UserController`/etc.
 * — none use `hasAnyRole`), so this takes one role, not a list.
 */
export function requireRole(user: CurrentUser, role: UserRole): void {
  if (user.role !== role) {
    throw new RoleNotAllowedError();
  }
}
