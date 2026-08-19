import "server-only";
import { ForbiddenError } from "@/lib/errors";
import { findById as findUserById } from "./user.queries";
import type { User } from "./user.types";

/**
 * User lookup service (replaces `business.service.user.UserService`).
 *
 * Holds no authentication/authorization logic — same division of
 * responsibility as the source, where `AuthService` owns
 * registration/login and `UserService` only looks accounts up. Only
 * `findById` is ported for this phase; `search`/`suspend`/`reactivate` are
 * not ported here — Phase 7, alongside the admin user-management routes
 * that call them.
 *
 * SOURCE: drone-missions-backend/.../business/service/user/UserService.java (`findById` only)
 */

/**
 * Thrown when a suspended account attempts an action moderation forbids —
 * creating missions (Phase 2), bidding, or executing awarded work. Mirrors
 * `UserSuspendedException`, whose base (`business/ForbiddenException.java`)
 * maps to 403.
 *
 * Declared here, in the user feature's business layer, because it is a fact
 * about the *account*, not about whatever the account was trying to do — the
 * source likewise files it under `business/exception/user`, and throws it
 * from the mission, bid and lifecycle services alike.
 */
export class UserSuspendedError extends ForbiddenError {
  constructor() {
    super("This account is suspended and cannot perform this action");
  }
}

/**
 * Looks up a user by id. The query layer already implements the
 * "throw if missing" behavior (see `user.queries.ts`'s `findById`); this
 * service function exists so route handlers depend on the service layer
 * rather than the DAO directly, exactly as the source's `UserController`
 * depends on `UserService`, not `UserRepository`.
 *
 * @throws UserNotFoundError if no user has the given id — mirrors
 * `UserService.findById`'s `orElseThrow(() -> new UserNotFoundException(id))`.
 */
export async function findById(id: number): Promise<User> {
  return findUserById(id);
}
