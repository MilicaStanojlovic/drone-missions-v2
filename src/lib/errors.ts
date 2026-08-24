import "server-only";

/**
 * Application error model (replaces the `NotFoundException` /
 * `UnauthorizedException` / `ForbiddenException` / `ConflictException`
 * abstract base classes in the Spring backend's `business` package).
 *
 * Each subclass here is the direct counterpart of one Spring base exception
 * and carries the same HTTP status. Domain-specific errors (e.g. a
 * "mission not found" error) extend the matching subclass exactly the way
 * the Spring backend extends the matching abstract base — the exception
 * *type* documents what went wrong, and a single place
 * (`withErrorHandling()` in `src/lib/api/handler.ts`) maps the whole family
 * to its HTTP status, mirroring `GlobalExceptionHandler`.
 *
 * Do not throw `AppError` directly — always throw (or extend) one of the
 * four subclasses below, matching the source's "do not throw the base type
 * directly" convention.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/NotFoundException.java
 * - drone-missions-backend/.../business/UnauthorizedException.java
 * - drone-missions-backend/.../business/ForbiddenException.java
 * - drone-missions-backend/.../business/ConflictException.java
 */
export abstract class AppError extends Error {
  abstract readonly status: number;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore the prototype chain — `Error` subclassing gets mangled when
    // TypeScript compiles to a target where classes extending built-ins
    // don't automatically fix up `instanceof` (harmless no-op otherwise).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Base type for "resource not found" errors -> 404.
 * SOURCE: business/NotFoundException.java
 */
export abstract class NotFoundError extends AppError {
  readonly status = 404;
}

/**
 * Base type for "authentication failed" errors surfaced from the business
 * layer -> 401 (e.g. bad login credentials). Missing/invalid bearer tokens
 * are handled earlier, in `middleware.ts` — not through this type.
 * SOURCE: business/UnauthorizedException.java
 */
export abstract class UnauthorizedError extends AppError {
  readonly status = 401;
}

/**
 * Base type for "authenticated but not allowed" errors -> 403 (e.g. editing
 * someone else's mission, or a `requireRole()` denial — the equivalent of
 * both `ForbiddenException` and Spring Security's `AuthorizationDeniedException`,
 * which the source maps to the same 403).
 * SOURCE: business/ForbiddenException.java
 */
export abstract class ForbiddenError extends AppError {
  readonly status = 403;
}

/**
 * Base type for "conflicts with existing state" errors -> 409 (e.g.
 * duplicate email).
 * SOURCE: business/ConflictException.java
 */
export abstract class ConflictError extends AppError {
  readonly status = 409;
}
