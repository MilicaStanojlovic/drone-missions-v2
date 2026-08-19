import "server-only";
import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, type UserRole } from "@/db/schema";
import { offsetOf, type Page, type PageRequest } from "@/lib/api/paging";
import { NotFoundError } from "@/lib/errors";
import type { NewUser, User } from "./user.types";

/**
 * User lookup, insert and admin-listing queries (replaces
 * `data.repository.UserRepository`'s `findByEmail`/`existsByEmail`/`search`
 * and the id lookup half of `business.service.user.UserService` — `findById`'s
 * "throw if missing" behavior is folded in here rather than left to a separate
 * service, since Phase 1 had no `user.service.ts` yet).
 *
 * The aggregate queries (`countByRoleAndSuspendedFalse`, `countBySuspendedTrue`,
 * `countByRole`) feed the admin statistics endpoint and live at the bottom of
 * this module: they return counts rather than `User` rows, exactly as the
 * source's `long` counts and `RoleCount` projection do.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/repository/UserRepository.java (`findByEmail`, `existsByEmail`, `search`, the three counts + `RoleCount`)
 * - drone-missions-backend/.../business/service/user/UserService.java (`findById`, the `repository.save` in `suspend`/`reactivate`)
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
 * The admin listing. Mirrors `UserRepository.search`'s
 * `select u from User u where (:role is null or u.role = :role)` — a null role
 * means "everyone", the same convention the audit search uses — paged, newest
 * account first.
 *
 * The `createdAt` DESC order is the `@PageableDefault(sort = "createdAt",
 * direction = DESC)` the controller declares; it lives here rather than
 * travelling in `PageRequest` because no client ever overrides it (see the
 * "no `sort`" note in `src/lib/api/paging.ts`).
 *
 * Note: `id DESC` is added as a tiebreaker, the same deviation
 * `notification.queries.ts` documents. The source orders by `created_at`
 * alone, which leaves rows sharing a timestamp in an unspecified order — and
 * unspecified order is worse under paging than without it, since a row can
 * then appear on two pages or on none. Ids are monotonic, so this keeps
 * "newest first" true rather than arbitrary without reordering any two rows
 * the source already ordered.
 *
 * The count is a second query against the same filter, exactly as Spring Data
 * issues one for a `Page`. Both run concurrently: they are independent reads,
 * and a row inserted between them can at worst make `totalElements` disagree
 * with `content` by one — the same benign race Spring's sequential pair has.
 */
export async function search(role: UserRole | null, request: PageRequest): Promise<Page<User>> {
  const db = getDb();
  const where = role === null ? undefined : eq(users.role, role);
  const [content, [total]] = await Promise.all([
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(request.size)
      .offset(offsetOf(request)),
    db.select({ value: count() }).from(users).where(where),
  ]);
  return { content, request, totalElements: total?.value ?? 0 };
}

/**
 * Flips one account's `suspended` flag and returns the updated row.
 *
 * The port of the `repository.save(user)` inside `UserService.suspend`/
 * `reactivate`: there, the service mutates the loaded entity and JPA flushes
 * the dirty column, with `@UpdateTimestamp` restamping `updated_at` on the
 * way out. Expressed as a targeted `UPDATE` here — the same two columns the
 * flush would write — rather than a whole-row save, so a concurrent change to
 * an unrelated column cannot be clobbered by a stale in-memory snapshot.
 *
 * Callers only reach this after `findById` has confirmed the account exists,
 * and nothing in the application ever deletes a user row (moderation suspends,
 * it never removes), so the "no row matched" branch is unreachable in practice;
 * it throws rather than returning `undefined` so the impossible case cannot
 * silently report a suspension that never happened.
 *
 * @throws UserNotFoundError if the row disappeared between the lookup and here
 */
export async function setSuspended(id: number, suspended: boolean): Promise<User> {
  const [updated] = await getDb()
    .update(users)
    .set({ suspended, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  if (!updated) {
    throw new UserNotFoundError(id);
  }
  return updated;
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

/**
 * One row of `countByRole` — mirrors the source's `RoleCount` Spring Data
 * projection, whose whole purpose is to keep the aggregate typed instead of an
 * `Object[]` row. `total` is a `number` rather than the projection's `Long`:
 * an account count cannot approach 2^53, and the platform-stats response
 * writes it as a JSON number either way.
 */
export interface RoleCount {
  role: UserRole;
  total: number;
}

/**
 * How many accounts of one role are *not* suspended — the overview's "active
 * pilots" tile, called with `PILOT`. Mirrors the derived query
 * `UserRepository.countByRoleAndSuspendedFalse(UserRole)`, whose method name
 * Spring Data expands to `where role = :role and suspended = false`.
 *
 * Both halves matter: a suspended pilot is excluded even though the role
 * matches, and a suspended account of another role is excluded by the role
 * predicate rather than being quietly counted here — which is what makes this
 * count and `countBySuspendedTrue` below independent readings rather than two
 * halves of one split.
 */
export async function countByRoleAndSuspendedFalse(role: UserRole): Promise<number> {
  const [row] = await getDb()
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, role), eq(users.suspended, false)));
  return row?.value ?? 0;
}

/**
 * Suspended accounts across every role — the source's javadoc in as many
 * words, and the reason no role predicate appears here. Mirrors the derived
 * query `UserRepository.countBySuspendedTrue()`.
 *
 * `suspended` is `NOT NULL DEFAULT false` (V16, which replaced V13's nullable
 * `suspended_at` timestamp), so `= true` needs no null handling: every row
 * falls on exactly one side of it.
 */
export async function countBySuspendedTrue(): Promise<number> {
  const [row] = await getDb()
    .select({ value: count() })
    .from(users)
    .where(eq(users.suspended, true));
  return row?.value ?? 0;
}

/**
 * The account count per role. Mirrors `UserRepository.countByRole()`:
 *
 * ```
 * select u.role as role, count(u) as total from User u group by u.role
 * ```
 *
 * Sparse by construction — a role nobody holds produces no group and is simply
 * absent from the list, never present as a zero. Zero-filling over every
 * `UserRole` is the stats service's job, exactly as it is in the source
 * (`PlatformStatsService` seeds the map with all roles before folding these
 * rows in), so this stays the faithful shape of the SQL rather than a map the
 * DAO has already padded.
 *
 * Suspension is not filtered: this counts *accounts*, so a suspended user
 * still belongs to their role's bar. The suspended total is the separate
 * reading `countBySuspendedTrue` gives.
 *
 * No `ORDER BY`, like the source: the only consumer folds the rows into a map
 * keyed by role, so their order is unobservable.
 */
export async function countByRole(): Promise<RoleCount[]> {
  return getDb().select({ role: users.role, total: count() }).from(users).groupBy(users.role);
}
