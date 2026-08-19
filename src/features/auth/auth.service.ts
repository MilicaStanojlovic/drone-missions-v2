import "server-only";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { signJwt } from "@/lib/auth/jwt";
import { existsByEmail, findByEmail, insertUser } from "@/features/users/user.queries";
import type { User } from "@/features/users/user.types";
import type { UserRole } from "@/db/schema";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { record, userLoggedIn, userRegistered } from "@/lib/audit";

/**
 * Registration and authentication (replaces `business.service.auth.AuthService`).
 *
 * `createUser` and `login` are ported in this phase — `createAdmin` (the
 * authenticated-admin path past the self-registration guard below) is
 * Phase 7.
 *
 * Credential verification here is a direct bcrypt-compare against the
 * looked-up row rather than delegating to a Spring-Security-style
 * `AuthenticationManager`/`UserDetailsService` pipeline (`CustomUserDetailsService`
 * + `UserPrincipal` have no runtime counterpart — there is no framework
 * authentication layer to bridge to), but the outcome matches exactly:
 * an unknown email and a wrong password are indistinguishable to the
 * caller, both surfacing as the single `InvalidCredentialsError` below.
 *
 * SOURCE: drone-missions-backend/.../business/service/auth/AuthService.java (`createUser`, `login`)
 */

/**
 * Thrown when registration asks for the ADMIN role. Admin accounts are
 * seeded by migration, never self-registered. Mirrors
 * `AdminRegistrationNotAllowedException`, whose base
 * (`business/ForbiddenException.java`) maps to 403.
 */
export class AdminRegistrationNotAllowedError extends ForbiddenError {
  constructor() {
    super("Admin accounts cannot be self-registered");
  }
}

/**
 * Thrown on registration when the email is already taken -> 409. Mirrors
 * `EmailAlreadyExistsException` — the message deliberately does not confirm
 * which field clashed beyond the email the caller already supplied.
 */
export class EmailAlreadyExistsError extends ConflictError {
  constructor(email: string) {
    super(`Email ${email} is already registered`);
  }
}

/**
 * Thrown on login when the email is unknown or the password does not
 * match -> 401. Mirrors `InvalidCredentialsException`: the message is
 * deliberately generic and never reveals which half was wrong, to avoid
 * account enumeration.
 */
export class InvalidCredentialsError extends UnauthorizedError {
  constructor() {
    super("Invalid email or password");
  }
}

/**
 * Outcome of a successful login: the issued JWT and the authenticated
 * user. Mirrors the `LoginResult` record — never serialized as-is; the
 * route puts the token in the response header and shapes the user through
 * `toUserResponse` for the body.
 */
export interface LoginResult {
  token: string;
  user: User;
}

/**
 * Registers a new account. Mirrors `AuthService.createUser`: reject ADMIN
 * self-registration, reject a duplicate email, hash the raw password,
 * insert, and audit the new user as its own actor — in that order, so a
 * rejected request never inserts a row or writes an audit entry.
 *
 * @throws AdminRegistrationNotAllowedError if `role` is ADMIN
 * @throws EmailAlreadyExistsError if the email is already registered
 */
export async function createUser(
  username: string,
  email: string,
  rawPassword: string,
  role: UserRole,
): Promise<User> {
  if (role === "ADMIN") {
    throw new AdminRegistrationNotAllowedError();
  }
  if (await existsByEmail(email)) {
    throw new EmailAlreadyExistsError(email);
  }
  const passwordHash = await hashPassword(rawPassword);
  const user = await insertUser({ username, email, passwordHash, role });
  await record(userRegistered(user));
  return user;
}

/**
 * Authenticates by email + password and mints a JWT on success. Mirrors
 * `AuthService.login`: look up by email, verify the password — both an
 * unknown email and a wrong password surface the single
 * `InvalidCredentialsError`, exactly like Spring Security hiding
 * "user not found" as bad credentials — then audit `userLoggedIn` and
 * generate the token, in that order (a failed attempt never audits and
 * never mints a token).
 *
 * @throws InvalidCredentialsError if the email is unknown or the password is wrong
 */
export async function login(email: string, rawPassword: string): Promise<LoginResult> {
  const user = await findByEmail(email);
  if (!user || !(await verifyPassword(rawPassword, user.passwordHash))) {
    throw new InvalidCredentialsError();
  }
  await record(userLoggedIn(user));
  const token = await signJwt(user.id, user.role);
  return { token, user };
}
