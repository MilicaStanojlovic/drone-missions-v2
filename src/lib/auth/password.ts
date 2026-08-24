import "server-only";
import bcrypt from "bcryptjs";

/**
 * Password hashing (replaces the `PasswordEncoder` bean in `SecurityConfig`,
 * which is a plain `new BCryptPasswordEncoder()` — BCrypt, `$2a$` version,
 * default strength/cost factor 10).
 *
 * `bcryptjs` is a pure-JS, spec-compliant BCrypt implementation: it produces
 * and verifies the same `$2a$`-prefixed hash format Spring emits, and treats
 * the `$2a$`/`$2b$`/`$2y$` version prefixes as interchangeable on verify (the
 * revisions only affect a historical 8-bit-character edge case in hashing,
 * never verification of an already-produced hash) — so a hash minted by the
 * Java backend continues to verify unchanged after the port. See
 * `password.test.ts` for a fixture proving this round-trip.
 *
 * SOURCE: drone-missions-backend/.../config/SecurityConfig.java (passwordEncoder bean).
 */

/** Cost factor 10 — BCryptPasswordEncoder's default strength, unchanged here. */
const SALT_ROUNDS = 10;

/**
 * Hashes a raw password for storage. Mirrors `passwordEncoder.encode(rawPassword)`.
 *
 * Discrepancy from source (intentional, noted for the record): `bcryptjs`
 * always mints the `$2b$` revision prefix and exposes no option to force
 * `$2a$` (unlike Spring's `BCryptPasswordEncoder`, which always emits
 * `$2a$`). This has no behavioral effect — `$2a$`/`$2b$`/`$2y$` differ only
 * in a historical hashing edge case for passwords over 255 bytes and are
 * fully interchangeable on verification — so existing `$2a$` hashes from
 * the Java backend keep verifying unchanged (see `password.test.ts`); only
 * hashes minted going forward by *this* app carry the `$2b$` prefix.
 */
export async function hashPassword(rawPassword: string): Promise<string> {
  return bcrypt.hash(rawPassword, SALT_ROUNDS);
}

/**
 * Verifies a raw password against a stored BCrypt hash (including hashes
 * minted by the Spring backend's `BCryptPasswordEncoder`). Mirrors
 * `passwordEncoder.matches(rawPassword, user.getPasswordHash())`.
 */
export async function verifyPassword(rawPassword: string, hash: string): Promise<boolean> {
  return bcrypt.compare(rawPassword, hash);
}
