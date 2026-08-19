import "server-only";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { env } from "@/lib/env";
import type { UserRole } from "@/db/schema";

/**
 * HS256 JWT mint/verify (replaces the `JwtEncoder`/`JwtDecoder` beans in
 * `SecurityConfig` and `AuthService.generateToken`).
 *
 * - Algorithm: HS256, key = `SecretKeySpec(JWT_SECRET.getBytes(UTF_8), "HmacSHA256")`
 *   — i.e. the raw UTF-8 bytes of `JWT_SECRET`, no base64 decoding.
 * - Claims: `sub` = the user id as a string (`String.valueOf(user.getId())`),
 *   `role` = the user's role name (`user.getRole().name()`), `iat` = now,
 *   `exp` = now + `JWT_EXPIRATION_MS`.
 *
 * `jose`'s `setIssuedAt`/`setExpirationTime` treat a `Date` argument as an
 * *absolute* point in time (not a delta), so passing `now` and
 * `now + JWT_EXPIRATION_MS` directly mirrors the source's
 * `Instant.now()` / `now.plusMillis(jwtExpirationMs)` exactly (both are
 * truncated to whole seconds when serialized as a JWT NumericDate, matching
 * what Nimbus's `JwtEncoder` does on the Java side).
 *
 * SOURCE:
 * - drone-missions-backend/.../config/SecurityConfig.java (jwtSecretKey, jwtDecoder, jwtEncoder beans)
 * - drone-missions-backend/.../business/service/auth/AuthService.java (generateToken)
 */

const ALGORITHM = "HS256";

/** The shared HMAC key backing both minting and verification — raw UTF-8 bytes of JWT_SECRET. */
const secretKey = new TextEncoder().encode(env.JWT_SECRET);

/** The claims this app puts on (and expects back off) a token. */
export interface AppJwtClaims {
  /** The user id, as a string — the token's `sub` claim. */
  sub: string;
  /** The user's role. */
  role: UserRole;
  /** Issued-at, seconds since the epoch. */
  iat: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/**
 * Mints an HS256 token for the given user. Mirrors `AuthService.generateToken`:
 * subject = user id, `role` claim, `iat`/`exp` from `JWT_EXPIRATION_MS`.
 */
export async function signJwt(userId: number, role: UserRole): Promise<string> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.JWT_EXPIRATION_MS);
  return new SignJWT({ role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(String(userId))
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(secretKey);
}

/** Thrown for any invalid token: bad signature, malformed, or expired. */
export class InvalidJwtError extends Error {
  constructor(cause?: unknown) {
    super("Invalid or expired token");
    this.name = "InvalidJwtError";
    this.cause = cause;
  }
}

/**
 * Verifies a token's signature and expiry and returns its claims. Mirrors
 * `JwtDecoder`'s validation (the resource-server filter that runs ahead of
 * `jwtAuthenticationConverter()`). Throws `InvalidJwtError` for any failure
 * — bad/foreign signature, malformed compact JWT, or an expired `exp` —
 * matching the source's single "unauthenticated" outcome for all three.
 */
export async function verifyJwt(token: string): Promise<AppJwtClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: [ALGORITHM] });
    if (typeof payload.sub !== "string" || typeof payload.role !== "string") {
      throw new InvalidJwtError();
    }
    return {
      sub: payload.sub,
      role: payload.role as UserRole,
      iat: payload.iat as number,
      exp: payload.exp as number,
    };
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) {
      throw new InvalidJwtError(error);
    }
    throw error;
  }
}
