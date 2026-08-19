import "server-only";
import type { PublicUserResponse, User, UserResponse } from "./user.types";

/**
 * Entity -> response DTO mapping (replaces `web.mapper.user.UserMapper`).
 *
 * Both of the source mapper's methods live here: `toUserResponse` (the full
 * view — the caller's own profile, and the admin listing) and
 * `toPublicUserResponse` (what one account may see about another).
 *
 * SOURCE: drone-missions-backend/.../web/mapper/user/UserMapper.java
 */

/**
 * Shapes a full `User` row into the public `UserResponse` — explicitly
 * whitelists every field so the password hash can never leak through by
 * accident (e.g. via an object spread added later).
 */
export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    suspended: user.suspended,
    createdAt: user.createdAt,
  };
}

/**
 * Shapes a `User` row into the stranger's view — `PublicUserResponse`.
 * Mirrors `UserMapper.toPublicResponse`: id, username, role, createdAt, and
 * nothing else.
 *
 * The two omissions are the point, and neither is an oversight:
 *
 * - **`email`** — personal data the marketplace has no reason to disclose to
 *   another account (the source says so in `PublicUserResponse`'s own doc
 *   comment). `GET /api/v1/users` keeps it because that endpoint is
 *   admin-only.
 * - **`suspended`** — moderation state is between an account and the admins;
 *   the source's public record simply has no such component.
 *
 * Fields are whitelisted one by one for the same reason as in
 * `toUserResponse`: a spread would silently republish whatever the `users`
 * row gains next, password hash included.
 */
export function toPublicUserResponse(user: User): PublicUserResponse {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
  };
}
