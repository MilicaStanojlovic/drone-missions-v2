import "server-only";
import { getMissionDao } from "@/features/missions/server/mission.cache";
import type { UserRole } from "@/db/schema";
import type { Page, PageRequest } from "@/lib/api/paging";
import { record, userReactivated, userSuspended } from "@/lib/audit";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { findById as findUserById, search as searchUsers, setSuspended } from "@/features/users/server/user.queries";
import type { User } from "@/features/users/user.types";

/**
 * User lookup and moderation service (replaces `business.service.user.UserService`).
 *
 * Holds no authentication/authorization logic — same division of
 * responsibility as the source, where `AuthService` owns
 * registration/login and `UserService` owns account lookup plus the two
 * moderation actions an admin can take against an account.
 *
 * `findByEmail` is not ported here: the source's `UserService.findByEmail`
 * exists only for `AuthService`'s benefit, and this port's `auth.service.ts`
 * calls `user.queries.ts` directly for it.
 *
 * SOURCE: drone-missions-backend/.../business/service/user/UserService.java
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
 * Thrown when an admin tries to suspend another ADMIN account — moderation
 * applies to marketplace roles only. Mirrors
 * `AdminCannotBeSuspendedException`, whose base
 * (`business/ConflictException.java`) maps to 409, message included.
 */
export class AdminCannotBeSuspendedError extends ConflictError {
  constructor(id: number) {
    super(`User ${id} is an admin and cannot be suspended`);
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

/**
 * The admin listing. Mirrors `UserService.search` — a straight delegation to
 * the repository, with a null role meaning "everyone".
 *
 * No `requireRole()` here: the source gates this at the controller
 * (`@PreAuthorize("hasRole('ADMIN')")` on `UserController.all`), and this port
 * keeps the gate at the same layer — the route handler — so the two agree on
 * where admin-only is enforced.
 */
export async function search(role: UserRole | null, request: PageRequest): Promise<Page<User>> {
  return searchUsers(role, request);
}

/**
 * Suspends an account: the suspended user can no longer design, bid, be
 * awarded work, or execute it, and their missions leave the marketplace.
 *
 * Three behaviors from the source, in its order:
 *
 * 1. **ADMIN targets are rejected** (409) before anything is written —
 *    moderation applies to marketplace roles only.
 * 2. **Idempotent.** Suspending an already-suspended account writes nothing,
 *    invalidates nothing and audits nothing; the account is returned as-is, so
 *    the endpoint still answers 200 with the current state. One audit row
 *    therefore means one state *change*, not one button press.
 * 3. **Feed lists are invalidated** even though no mission row was written. A
 *    suspended designer's missions drop out of the marketplace, and the write
 *    landed on the `users` table — which the mission cache never observes, so
 *    nothing else would evict the stale id lists. (Only the lists: the cached
 *    mission entities themselves are still correct.)
 *
 * The audit row is written last, after the save succeeds, as everywhere else
 * in this port.
 *
 * @param id the account to suspend
 * @param adminId the acting admin, recorded as the audit row's actor
 * @throws UserNotFoundError if no user has the given id
 * @throws AdminCannotBeSuspendedError if the target is an ADMIN
 */
export async function suspend(id: number, adminId: number): Promise<User> {
  const user = await findById(id);
  if (user.role === "ADMIN") {
    throw new AdminCannotBeSuspendedError(id);
  }
  if (user.suspended) {
    return user;
  }
  const saved = await setSuspended(id, true);
  getMissionDao().invalidateLists();
  await record(userSuspended(adminId, saved));
  return saved;
}

/**
 * Lifts a suspension. Mirrors `UserService.reactivate`: idempotent in the same
 * way (an already-active account writes, invalidates and audits nothing), and
 * invalidating the feed lists for the mirror-image reason — a reactivated
 * designer's missions rejoin the marketplace without a mission row being
 * written.
 *
 * There is no ADMIN guard here, and that asymmetry is the source's: an admin
 * account can never *become* suspended, so reactivating one is a no-op the
 * idempotence check already handles.
 *
 * @throws UserNotFoundError if no user has the given id
 */
export async function reactivate(id: number, adminId: number): Promise<User> {
  const user = await findById(id);
  if (!user.suspended) {
    return user;
  }
  const saved = await setSuspended(id, false);
  getMissionDao().invalidateLists();
  await record(userReactivated(adminId, saved));
  return saved;
}
