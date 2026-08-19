import "server-only";
import type { User, UserResponse } from "./user.types";

/**
 * Entity -> response DTO mapping (replaces `web.mapper.user.UserMapper.toResponse`).
 *
 * Only `toResponse`'s target is ported here — `toPublicResponse` (the
 * no-email view used when one account looks at another's profile) has no
 * caller yet in this phase and lands with whatever later phase first needs
 * it.
 *
 * SOURCE: drone-missions-backend/.../web/mapper/user/UserMapper.java (`toResponse`)
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
