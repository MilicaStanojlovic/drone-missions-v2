import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { NotFoundError } from "@/lib/errors";
import type { NewUser, User } from "./user.types";

/**
 * User lookup + insert queries (replaces `data.repository.UserRepository`'s
 * `findByEmail`/`existsByEmail` and the id lookup half of
 * `business.service.user.UserService` — `findById`'s "throw if missing"
 * behavior is folded in here rather than left to a separate service, since
 * this phase has no `user.service.ts` yet). Admin `search`/suspend/reactivate
 * queries are not ported here — Phase 7.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/repository/UserRepository.java (`findByEmail`, `existsByEmail`)
 * - drone-missions-backend/.../business/service/user/UserService.java (`findById` only)
 */

/**
 * Thrown when a user cannot be found by id. Mirrors
 * `UserNotFoundException` — the type alone conveys the error context,
 * without inspecting the message.
 */
export class UserNotFoundError extends NotFoundError {
  constructor(id: number) {
    super(`User ${id} not found`);
  }
}

/** Mirrors `UserRepository.findByEmail` — `undefined` when no row matches. */
export async function findByEmail(email: string): Promise<User | undefined> {
  const [user] = await getDb().select().from(users).where(eq(users.email, email));
  return user;
}

/** Mirrors `UserRepository.existsByEmail`. */
export async function existsByEmail(email: string): Promise<boolean> {
  const user = await findByEmail(email);
  return user !== undefined;
}

/**
 * Mirrors `UserRepository.findById` unchanged — `undefined` when no row
 * matches, for the callers that treat an absent account as "nothing to do"
 * rather than an error. `BidService.notifyDecision` is exactly that shape
 * (`userRepository.findById(pilotId).ifPresent(pilot -> …)`: no account, no
 * decision email, and the acceptance still stands).
 *
 * `findById` below is the same query with `UserService.findById`'s
 * `orElseThrow` folded in; both exist because the source has both usages.
 */
export async function findByIdOrUndefined(id: number): Promise<User | undefined> {
  const [user] = await getDb().select().from(users).where(eq(users.id, id));
  return user;
}

/**
 * @throws UserNotFoundError if no user has the given id — mirrors
 * `UserService.findById`'s `orElseThrow(() -> new UserNotFoundException(id))`.
 */
export async function findById(id: number): Promise<User> {
  const user = await findByIdOrUndefined(id);
  if (!user) {
    throw new UserNotFoundError(id);
  }
  return user;
}

/**
 * Inserts a new account. `id` is DB-generated, `suspended` defaults to
 * `false` at the schema level (mirrors the Java entity field default),
 * `createdAt`/`updatedAt` are stamped here the same way `audit.ts`'s
 * `record()` stamps `created_at` — the DB has no default for either column
 * (see `V3__Create_users_table.sql`), so the application must set them.
 */
export async function insertUser(newUser: NewUser): Promise<User> {
  const now = new Date();
  const [user] = await getDb()
    .insert(users)
    .values({
      username: newUser.username,
      email: newUser.email,
      passwordHash: newUser.passwordHash,
      role: newUser.role,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return user;
}
