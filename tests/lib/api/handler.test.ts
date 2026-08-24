import { describe, expect, it, vi, afterEach } from "vitest";
import { z, ZodError } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Vitest suite for the error pipeline (`withErrorHandling()`), mirroring
 * each `@ExceptionHandler` case in the Spring source one-for-one.
 *
 * SOURCE: drone-missions-backend/.../web/GlobalExceptionHandler.java — no
 * JUnit suite exists for it in the source repo, so its Javadoc'd
 * exception -> HTTP-response mappings are the spec these tests assert
 * against (see the doc comment on `withErrorHandling()` for the full
 * case-by-case mapping this mirrors).
 */

// `AppError` subclasses in src/lib/errors.ts are abstract on purpose (mirroring
// the source's abstract exception base classes) — domain code always throws a
// concrete subclass. These minimal concrete subclasses stand in for that
// domain code so each base type can be exercised in isolation. Each needs its
// own public constructor forwarding to `super()`: a protected constructor is
// reachable from a subclass's own constructor body, but not for external
// `new TestNotFoundError(...)` call sites without one.
class TestNotFoundError extends NotFoundError {
  constructor(message: string) {
    super(message);
  }
}
class TestUnauthorizedError extends UnauthorizedError {
  constructor(message: string) {
    super(message);
  }
}
class TestForbiddenError extends ForbiddenError {
  constructor(message: string) {
    super(message);
  }
}
class TestConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
  }
}

/** A no-op Request; withErrorHandling never inspects it before the handler throws. */
const dummyRequest = new Request("http://localhost/api/test");

function throwingHandler(error: unknown) {
  return withErrorHandling(async () => {
    throw error;
  });
}

describe("withErrorHandling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes through a successful response unchanged", async () => {
    const wrapped = withErrorHandling(async () => Response.json({ ok: true }, { status: 200 }));
    const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  describe("ZodError -> 400 (mirrors handleValidation / MethodArgumentNotValidException)", () => {
    it("returns 400 with a field -> message map and the generic validation message", async () => {
      const schema = z.object({
        name: z.string().min(1, "Name is required"),
        email: z.string().email("Invalid email"),
      });
      const result = schema.safeParse({ name: "", email: "not-an-email" });
      expect(result.success).toBe(false);

      const wrapped = throwingHandler(result.error as ZodError);
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        data: { name: "Name is required", email: "Invalid email" },
        status: "BAD_REQUEST",
        message: "Data validation failed",
      });
    });

    it("keys the field->message map by root path when a field path is empty", async () => {
      const schema = z.string().min(1, "must not be empty");
      const result = schema.safeParse("");

      const wrapped = throwingHandler(result.error as ZodError);
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.data).toEqual({ "(root)": "must not be empty" });
    });

    it("renders an array-index path as bracket notation, matching Spring's BindingResult field format", async () => {
      // Spring's FieldError::getField renders a nested array field as
      // `waypoints[0].latitude`, not `waypoints.0.latitude` — the format
      // the frontend's mission-form component parses. Zod's own issue.path
      // is ["waypoints", 0, "latitude"]; withErrorHandling must translate it.
      const schema = z.object({
        waypoints: z.array(z.object({ latitude: z.number().min(-90, "Invalid latitude") })),
      });
      const result = schema.safeParse({ waypoints: [{ latitude: -1000 }] });
      expect(result.success).toBe(false);

      const wrapped = throwingHandler(result.error as ZodError);
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.data).toEqual({ "waypoints[0].latitude": "Invalid latitude" });
    });
  });

  describe("SyntaxError -> 400 (mirrors handleUnreadable / HttpMessageNotReadableException)", () => {
    it("returns 400 with the malformed-body message and no data", async () => {
      const wrapped = throwingHandler(new SyntaxError("Unexpected token in JSON"));
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        data: null,
        status: "BAD_REQUEST",
        message: "Malformed or unreadable request body",
      });
    });
  });

  describe("NotFoundError -> 404 (mirrors handleNotFound / NotFoundException)", () => {
    it("returns 404 with the thrown error's own message", async () => {
      const wrapped = throwingHandler(new TestNotFoundError("Mission not found"));
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toEqual({ data: null, status: "NOT_FOUND", message: "Mission not found" });
    });
  });

  describe("UnauthorizedError -> 401 (mirrors handleUnauthorized / UnauthorizedException)", () => {
    it("returns 401 with the thrown error's own message", async () => {
      const wrapped = throwingHandler(new TestUnauthorizedError("Invalid credentials"));
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body).toEqual({ data: null, status: "UNAUTHORIZED", message: "Invalid credentials" });
    });
  });

  describe("ForbiddenError -> 403 (mirrors handleForbidden / ForbiddenException)", () => {
    it("returns 403 with the thrown error's own message", async () => {
      const wrapped = throwingHandler(new TestForbiddenError("You do not own this mission"));
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        data: null,
        status: "FORBIDDEN",
        message: "You do not own this mission",
      });
    });
  });

  describe("ConflictError -> 409 (mirrors handleConflict / ConflictException)", () => {
    it("returns 409 with the thrown error's own message", async () => {
      const wrapped = throwingHandler(new TestConflictError("Email already in use"));
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toEqual({ data: null, status: "CONFLICT", message: "Email already in use" });
    });
  });

  describe("unexpected error -> 500 (mirrors handleGeneric / Exception.class)", () => {
    it("returns 500 with the generic message, never the internal error detail", async () => {
      const wrapped = throwingHandler(new Error("db connection string leaked: postgres://..."));
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toEqual({
        data: null,
        status: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      });
      expect(JSON.stringify(body)).not.toContain("postgres://");
    });

    it("still returns the generic 500 shape for a thrown non-Error value", async () => {
      const wrapped = throwingHandler("a raw string throw, not an Error instance");
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.message).toBe("An unexpected error occurred");
    });

    it("logs the full error server-side via pino", async () => {
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
      const internalError = new Error("boom");

      const wrapped = throwingHandler(internalError);
      await wrapped(dummyRequest, { params: Promise.resolve({}) });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        { err: internalError },
        "Unhandled error in route handler",
      );
    });
  });

  it("shapes every handled case as exactly { data, status, message }", async () => {
    const cases: unknown[] = [
      new SyntaxError("bad json"),
      new TestNotFoundError("nope"),
      new TestUnauthorizedError("nope"),
      new TestForbiddenError("nope"),
      new TestConflictError("nope"),
      new Error("boom"),
    ];

    for (const error of cases) {
      vi.spyOn(logger, "error").mockImplementation(() => logger);
      const wrapped = throwingHandler(error);
      const response = await wrapped(dummyRequest, { params: Promise.resolve({}) });
      const body = await response.json();
      expect(Object.keys(body).sort()).toEqual(["data", "message", "status"]);
    }
  });
});
