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
