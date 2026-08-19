import "server-only";
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
