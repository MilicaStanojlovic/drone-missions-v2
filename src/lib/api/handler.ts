import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * API error-handling wrapper (replaces `@RestControllerAdvice` /
 * `GlobalExceptionHandler`).
 *
 * Spring centralizes exception -> HTTP-response mapping in one
 * `@RestControllerAdvice` that every controller implicitly goes through.
 * The App Router has no such global hook for route handlers, so
 * `withErrorHandling()` wraps each one individually — call sites are
 * `export const POST = withErrorHandling(async (request) => { ... })` —
 * and reproduces the same case-by-case mapping `GlobalExceptionHandler` does,
 * emitting the exact same `{ data, status, message }` JSON envelope:
 *
 * - `ZodError` (the bean-validation equivalent — thrown by
 *   `schema.parse(...)` in a handler when the request body fails a Zod
 *   schema) -> 400, `data` a field -> message map, "Data validation failed".
 *   Mirrors `handleValidation` / `MethodArgumentNotValidException`.
 * - `SyntaxError` (thrown by `await request.json()` on a malformed body,
 *   the Fetch API's equivalent of `HttpMessageNotReadableException`) -> 400,
 *   "Malformed or unreadable request body". Mirrors `handleUnreadable`.
 * - `AppError` subclasses (`NotFoundError`, `UnauthorizedError`,
 *   `ForbiddenError`, `ConflictError` — see `src/lib/errors.ts`) -> their
 *   own status, the thrown error's message. Mirrors `handleNotFound` /
 *   `handleUnauthorized` / `handleForbidden` / `handleConflict`, whose
 *   Spring counterparts all pass `exception.getMessage()` straight through.
 * - Anything else (a genuine bug) -> 500, the generic
 *   "An unexpected error occurred" — the real error is logged server-side
 *   via `pino` with full detail, but never included in the response body.
 *   Mirrors `handleGeneric` / `@ExceptionHandler(Exception.class)`.
 *
 * `status` in the JSON body is the `HttpStatus` enum's *name* (e.g.
 * `"NOT_FOUND"`), not the numeric code — the source's `ErrorResponse.status`
 * field is typed `HttpStatus`, and Spring/Jackson serialize an unannotated
 * enum via `Enum.name()` by default (no `@JsonValue`/custom serializer is
 * registered on `HttpStatus` anywhere in the source). The numeric code is
 * still the actual HTTP response status, exactly as in the source.
 *
 * Not ported: `MethodArgumentTypeMismatchException`, `NoResourceFoundException`,
 * and `AuthorizationDeniedException` are Spring MVC/Security plumbing with no
 * Next.js equivalent (route matching is file-system based here, and
 * `requireRole()`/`requireOwner()` — see `src/lib/auth/guards.ts`, a later
 * task — throw `ForbiddenError` directly instead of a separate framework-level
 * denial type), so their dedicated `@ExceptionHandler`s have no counterpart:
 * a 404 for an unmatched route and a 400 for a bad query param are handled
 * by Next.js routing and per-handler Zod schemas respectively.
 *
 * SOURCE: drone-missions-backend/.../web/GlobalExceptionHandler.java
 */

/** Maps a numeric HTTP status to the `HttpStatus` enum name Jackson would
 * serialize it as, for the handled cases above. */
const STATUS_NAME: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  500: "INTERNAL_SERVER_ERROR",
};

/** The exact response envelope Spring's `ErrorResponse` record serializes to. */
interface ErrorResponseBody {
  data: unknown;
  status: string;
  message: string;
}

function errorResponse(
  status: number,
  message: string,
  data: unknown = null,
): NextResponse<ErrorResponseBody> {
  return NextResponse.json(
    { data, status: STATUS_NAME[status] ?? String(status), message },
    { status },
  );
}

/**
 * Renders a Zod issue `path` the way Spring's `FieldError::getField` renders
 * a `BindingResult` field path: dotted for object properties, but a bare
 * `[n]` suffix (no separating dot) for array indices — e.g. Zod's
 * `["waypoints", 0, "latitude"]` becomes `waypoints[0].latitude`, not
 * `waypoints.0.latitude`. The existing Angular client parses the bracket
 * form (see `<frontend>/src/app/components/mission-form/mission-form.component.ts`),
 * and the flight-plan validators land on this in Phase 2, so the format has
 * to match now.
 */
function fieldPath(path: ZodError["issues"][number]["path"]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    const key = String(segment);
    return acc ? `${acc}.${key}` : key;
  }, "");
}

/**
 * Flattens a `ZodError` into a field -> message map, one message per field —
 * the same shape `GlobalExceptionHandler.getValidationErrors` builds from
 * Spring's `BindingResult.getFieldErrors()` (first/only message per field,
 * keyed by field path).
 */
function fieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? fieldPath(issue.path) : "(root)";
    if (!(path in out)) {
      out[path] = issue.message;
    }
  }
  return out;
}

type RouteContext = { params: Promise<Record<string, string>> };

type RouteHandler<Ctx extends RouteContext> = (
  request: Request,
  context: Ctx,
) => Promise<Response> | Response;

/**
 * Wraps a route handler so any thrown `ZodError`, `SyntaxError`, or
 * `AppError` (and any other unexpected error) is converted into the shared
 * `{ data, status, message }` JSON error envelope instead of propagating
 * into an unhandled framework 500. See the module doc comment above for the
 * full case-by-case mapping.
 */
export function withErrorHandling<Ctx extends RouteContext = RouteContext>(
  handler: RouteHandler<Ctx>,
): RouteHandler<Ctx> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof ZodError) {
        return errorResponse(400, "Data validation failed", fieldErrors(error));
      }
      if (error instanceof SyntaxError) {
        return errorResponse(400, "Malformed or unreadable request body");
      }
      if (error instanceof AppError) {
        return errorResponse(error.status, error.message);
      }
      logger.error({ err: error }, "Unhandled error in route handler");
      return errorResponse(500, "An unexpected error occurred");
    }
  };
}
