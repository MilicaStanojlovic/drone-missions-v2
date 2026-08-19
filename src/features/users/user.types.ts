import "server-only";
import type { users } from "@/db/schema";

/**
 * User domain types (replaces `data.model.User` + the public
 * `web.dto.auth.UserResponse` record).
 *
 * `User` is the full row as it comes back from `user.queries.ts` — it still
 * carries `passwordHash`, exactly like the Java `User` entity carries the
 * BCrypt hash internally. It must never cross an API boundary as-is; routes
 * always shape it through `user.mapper.ts`'s `toUserResponse` first.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/model/User.java
 * - drone-missions-backend/.../web/dto/auth/UserResponse.java
 * - drone-missions-backend/.../web/dto/user/PublicUserResponse.java
 */

/** The full `users` row, exactly as stored — includes the password hash. */
export type User = typeof users.$inferSelect;

/**
 * Public view of a user account — never exposes the password hash. Mirrors
 * `UserResponse` field-for-field (id, username, email, role, suspended,
 * createdAt).
 */
export interface UserResponse {
  id: number;
  username: string;
  email: string;
  role: User["role"];
  suspended: boolean;
  createdAt: Date;
}

/**
 * What one account may see about *another* — `GET /api/v1/users/{id}`, the
 * view behind the profile page. Mirrors `PublicUserResponse` field-for-field
 * (id, username, role, createdAt).
 *
 * Deliberately narrower than `UserResponse`: no `email` (personal data the
 * marketplace has no reason to hand to strangers — the source's own wording)
 * and no `suspended`. It is not a `Partial<UserResponse>`/`Omit<>` of it
 * precisely so that adding a field to the admin view can never widen this one
 * by accident.
 */
export interface PublicUserResponse {
  id: number;
  username: string;
  role: User["role"];
  createdAt: Date;
}

/**
 * Parameters for inserting a new account. Mirrors the fields the source
 * sets explicitly when constructing a new `User` at registration —
 * `id`/`suspended`/`createdAt`/`updatedAt` are left to the database's
 * identity/default/insert-time stamping, the same way the Java entity
 * leaves them to `@GeneratedValue`/the `suspended` field default/
 * `@CreationTimestamp`/`@UpdateTimestamp`.
 */
export interface NewUser {
  username: string;
  email: string;
  passwordHash: string;
  role: User["role"];
}
