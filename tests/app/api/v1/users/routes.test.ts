import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import type { Page } from "@/lib/api/paging";
import type { UserRole } from "@/db/schema";
import type { User } from "@/features/users/user.types";

/**
 * Route-level suite for the admin user endpoints: `GET /api/v1/users`,
 * `GET /api/v1/users/{id}`, `POST /api/v1/users/admins`, and
 * `POST /api/v1/users/{id}/{suspend,reactivate}`.
 *
 * Mirrors `UserControllerTest`, which is a Mockito unit test of the controller
 * rather than a live-database one: `UserService` is mocked so the assertions
 * are about what the *web layer* does — the filter and page request it hands
 * the service, the envelope it wraps the answer in, the response shape each
 * endpoint chooses, and the authorization each one enforces. That is the same
 * shape as `src/app/api/v1/missions/routes.test.ts`: `search`, `suspend` and
 * `reactivate` already have their own behavior suite in
 * `src/features/users/user.service.test.ts`.
 *
 * The same endpoints over a real database — the writes, the audit rows, the
 * cache eviction and the bcrypt hash, none of which survive a mocked service —
 * are in `routes.live.test.ts` beside this file, the same split
 * `missions/routes.test.ts` has beside `missions/routes.live.test.ts`.
 *
 * The 401 cases go through `middleware()` itself, the layer that actually
 * rejects an anonymous caller in the deployed app (none of these paths are in
 * its `PUBLIC_PATHS`), following the precedent of the auth/users/notifications
 * suites. The 403 cases call the handlers with a verified non-admin's headers,
 * since `requireRole()` is what stands in for `@PreAuthorize("hasRole('ADMIN')")`.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/controller/user/UserController.java
 * - test .../web/controller/user/UserControllerTest.java
 */

const searchMock = vi.fn();
const findByIdMock = vi.fn();
const suspendMock = vi.fn();
const reactivateMock = vi.fn();
vi.mock("@/features/users/server/user.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/users/server/user.service")>();
  return {
    ...actual,
    search: (...args: unknown[]) => searchMock(...args),
    findById: (...args: unknown[]) => findByIdMock(...args),
    suspend: (...args: unknown[]) => suspendMock(...args),
    reactivate: (...args: unknown[]) => reactivateMock(...args),
  };
});

const createAdminMock = vi.fn();
vi.mock("@/features/auth/server/auth.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/auth/server/auth.service")>();
  return { ...actual, createAdmin: (...args: unknown[]) => createAdminMock(...args) };
});

// `vi.mock` is hoisted, so these already resolve against the mocked module.
import { AdminCannotBeSuspendedError } from "@/features/users/server/user.service";
import { EmailAlreadyExistsError } from "@/features/auth/server/auth.service";
import { UserNotFoundError } from "@/features/users/server/user.queries";
import { middleware } from "@/middleware";
import { GET as listRoute } from "@/app/api/v1/users/route";
import { GET as byIdRoute } from "@/app/api/v1/users/[id]/route";
import { POST as createAdminRoute } from "@/app/api/v1/users/admins/route";
import { POST as suspendRoute } from "@/app/api/v1/users/[id]/suspend/route";
import { POST as reactivateRoute } from "@/app/api/v1/users/[id]/reactivate/route";

const ADMIN_ID = 80;
const PILOT_ID = 3;

/** The context Next.js hands a non-dynamic route handler. */
const listContext = { params: Promise.resolve({}) };

/** The context Next.js hands `users/[id]` (and its sub-routes) for a path segment. */
function idContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** The headers `src/middleware.ts` attaches from a verified token's claims. */
function request(url: string, userId = ADMIN_ID, role: UserRole = "ADMIN"): Request {
  return new Request(url, {
    headers: { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role },
  });
}

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: PILOT_ID,
    username: "pilot-mira",
    email: "mira@example.com",
    passwordHash: "$2b$10$abcdefghijklmnopqrstuv",
    role: "PILOT",
    suspended: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

/** `new PageImpl<>(List.of(user), pageable, total)`. */
function page(content: User[], pageIndex: number, size: number, totalElements: number): Page<User> {
  return { content, request: { page: pageIndex, size }, totalElements };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/users", () => {
  it("passes the filter and page request through and wraps the page (listPassesFilterAndPageableAndWrapsThePage)", async () => {
    searchMock.mockResolvedValue(page([fakeUser()], 1, 5, 6));

    const response = await listRoute(
      request("http://localhost/api/v1/users?role=PILOT&page=1&size=5"),
      listContext,
    );
    const body = await response.json();

    expect(searchMock).toHaveBeenCalledWith("PILOT", { page: 1, size: 5 });
    expect(response.status).toBe(200);
    expect(body.content).toHaveLength(1);
    expect(body.content[0].username).toBe("pilot-mira");
    expect(body.page.totalElements).toBe(6);
    // `PagedModel`'s remaining metadata, which the Angular pager reads.
    expect(body.page).toEqual({ size: 5, number: 1, totalElements: 6, totalPages: 2 });
  });

  it("is the admin view: the full UserResponse, email included, no password hash", async () => {
    searchMock.mockResolvedValue(page([fakeUser()], 0, 20, 1));

    const response = await listRoute(request("http://localhost/api/v1/users"), listContext);
    const body = await response.json();

    expect(Object.keys(body.content[0]).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "role",
      "suspended",
      "username",
    ]);
    expect(body.content[0].email).toBe("mira@example.com");
    expect(body.content[0]).not.toHaveProperty("passwordHash");
  });

  it("applies the @PageableDefault of size 20, page 0 when the query string is empty", async () => {
    searchMock.mockResolvedValue(page([], 0, 20, 0));

    await listRoute(request("http://localhost/api/v1/users"), listContext);

    expect(searchMock).toHaveBeenCalledWith(null, { page: 0, size: 20 });
  });

  it("reads an absent role as 'everyone' — the repository's `:role is null` branch", async () => {
    searchMock.mockResolvedValue(page([], 0, 20, 0));

    await listRoute(request("http://localhost/api/v1/users?page=2"), listContext);

    expect(searchMock).toHaveBeenCalledWith(null, { page: 2, size: 20 });
  });

  it("reads an empty role the same way, so the Angular 'All roles' option clears the filter", async () => {
    searchMock.mockResolvedValue(page([], 0, 20, 0));

    await listRoute(request("http://localhost/api/v1/users?role="), listContext);

    expect(searchMock).toHaveBeenCalledWith(null, { page: 0, size: 20 });
  });

  it("rejects an unknown role with 400 and never reaches the service", async () => {
    const response = await listRoute(
      request("http://localhost/api/v1/users?role=SUPERVISOR"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.status).toBe("BAD_REQUEST");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns an empty page (not 404) when nothing matches", async () => {
    searchMock.mockResolvedValue(page([], 0, 20, 0));

    const response = await listRoute(
      request("http://localhost/api/v1/users?role=ADMIN"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.content).toEqual([]);
    expect(body.page).toEqual({ size: 20, number: 0, totalElements: 0, totalPages: 0 });
  });

  it("rejects a designer with 403 and never reaches the service", async () => {
    const response = await listRoute(
      request("http://localhost/api/v1/users", 7, "DESIGNER"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      data: null,
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("rejects a pilot with 403", async () => {
    const response = await listRoute(
      request("http://localhost/api/v1/users", PILOT_ID, "PILOT"),
      listContext,
    );

    expect(response.status).toBe(403);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(new NextRequest(new URL("http://localhost/api/v1/users")));
    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/users/{id}", () => {
  it("returns the public view — no email, no suspension flag, no password hash", async () => {
    findByIdMock.mockResolvedValue(fakeUser({ suspended: true }));

    const response = await byIdRoute(request(`http://localhost/api/v1/users/${PILOT_ID}`), {
      params: Promise.resolve({ id: String(PILOT_ID) }),
    });
    const body = await response.json();

    expect(findByIdMock).toHaveBeenCalledWith(PILOT_ID);
    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: PILOT_ID,
      username: "pilot-mira",
      role: "PILOT",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("suspended");
    expect(body).not.toHaveProperty("passwordHash");
  });

  it("serves an authenticated non-admin — this endpoint is isAuthenticated(), not hasRole('ADMIN')", async () => {
    findByIdMock.mockResolvedValue(fakeUser({ id: 9, username: "dana", role: "DESIGNER" }));

    const response = await byIdRoute(
      request("http://localhost/api/v1/users/9", PILOT_ID, "PILOT"),
      idContext("9"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: 9, username: "dana", role: "DESIGNER" });
  });

  it("returns 404 for an id that does not exist", async () => {
    findByIdMock.mockRejectedValue(new UserNotFoundError(404_404));

    const response = await byIdRoute(
      request("http://localhost/api/v1/users/404404"),
      idContext("404404"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ data: null, status: "NOT_FOUND", message: "User 404404 not found" });
  });

  it("returns 400 for a non-numeric id, the way Spring's Long converter would", async () => {
    const response = await byIdRoute(
      request("http://localhost/api/v1/users/not-a-number"),
      idContext("not-a-number"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.status).toBe("BAD_REQUEST");
    expect(body.data).toMatchObject({ id: "must be a number" });
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(new NextRequest(new URL("http://localhost/api/v1/users/3")));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/v1/users/admins", () => {
  /** A JSON POST carrying the headers `src/middleware.ts` attaches from a verified token. */
  function postAdmin(body: unknown, userId = ADMIN_ID, role: UserRole = "ADMIN"): Request {
    return new Request("http://localhost/api/v1/users/admins", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [USER_ID_HEADER]: String(userId),
        [USER_ROLE_HEADER]: role,
      },
      body: JSON.stringify(body),
    });
  }

  const newAdminBody = {
    username: "second-admin",
    email: "admin2@example.com",
    password: "pw-long-enough",
  };

  /** The account `AuthService.createAdmin` mints, as the Java test builds it. */
  const createdAdmin = fakeUser({
    id: 4,
    username: "second-admin",
    email: "admin2@example.com",
    role: "ADMIN",
  });

  it("passes the principal and returns 201 (createAdminPassesThePrincipalAndReturns201)", async () => {
    createAdminMock.mockResolvedValue(createdAdmin);

    const response = await createAdminRoute(postAdmin(newAdminBody), listContext);
    const body = await response.json();

    // The creating admin is the fourth argument and comes off the verified
    // token, never the request body — `@AuthenticationPrincipal long userId`.
    expect(createAdminMock).toHaveBeenCalledWith(
      "second-admin",
      "admin2@example.com",
      "pw-long-enough",
      ADMIN_ID,
    );
    expect(response.status).toBe(201);
    expect(body.username).toBe("second-admin");
    expect(body.role).toBe("ADMIN");
  });

  it("answers with the full UserResponse — email included, password hash never", async () => {
    createAdminMock.mockResolvedValue(createdAdmin);

    const response = await createAdminRoute(postAdmin(newAdminBody), listContext);
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "role",
      "suspended",
      "username",
    ]);
    expect(body.email).toBe("admin2@example.com");
    expect(body).not.toHaveProperty("passwordHash");
  });

  it("ignores a role smuggled into the body — the endpoint only ever mints an ADMIN", async () => {
    createAdminMock.mockResolvedValue(createdAdmin);

    await createAdminRoute(postAdmin({ ...newAdminBody, role: "PILOT" }), listContext);

    // `NewAdminRequest` has no `role` component, so Jackson drops it there and
    // the Zod object strips it here; `createAdmin` takes no role argument at
    // all, so nothing downstream could honour one.
    expect(createAdminMock).toHaveBeenCalledWith(
      "second-admin",
      "admin2@example.com",
      "pw-long-enough",
      ADMIN_ID,
    );
  });

  it("maps a duplicate email to 409 (EmailAlreadyExistsException)", async () => {
    createAdminMock.mockRejectedValue(new EmailAlreadyExistsError("admin2@example.com"));

    const response = await createAdminRoute(postAdmin(newAdminBody), listContext);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      data: null,
      status: "CONFLICT",
      message: "Email admin2@example.com is already registered",
    });
  });

  it("rejects a short password with 400 and never reaches the service (@Size(min = 8))", async () => {
    const response = await createAdminRoute(
      postAdmin({ ...newAdminBody, password: "short" }),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.status).toBe("BAD_REQUEST");
    expect(body.data).toMatchObject({ password: "password must be at least 8 characters" });
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed email with 400 and never reaches the service (@Email)", async () => {
    const response = await createAdminRoute(
      postAdmin({ ...newAdminBody, email: "not-an-email" }),
      listContext,
    );

    expect(response.status).toBe(400);
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it("rejects a designer with 403 and never reaches the service", async () => {
    const response = await createAdminRoute(postAdmin(newAdminBody, 7, "DESIGNER"), listContext);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      data: null,
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it("rejects a pilot with 403 — a valid body does not buy a non-admin the endpoint", async () => {
    const response = await createAdminRoute(
      postAdmin(newAdminBody, PILOT_ID, "PILOT"),
      listContext,
    );

    expect(response.status).toBe(403);
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/users/admins"), { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/v1/users/{id}/suspend", () => {
  it("passes the target and the acting admin, and answers 200 with the updated UserResponse", async () => {
    suspendMock.mockResolvedValue(fakeUser({ suspended: true }));

    const response = await suspendRoute(
      new Request(`http://localhost/api/v1/users/${PILOT_ID}/suspend`, {
        method: "POST",
        headers: { [USER_ID_HEADER]: String(ADMIN_ID), [USER_ROLE_HEADER]: "ADMIN" },
      }),
      idContext(String(PILOT_ID)),
    );
    const body = await response.json();

    // The acting admin comes off the verified token, never the request body.
    expect(suspendMock).toHaveBeenCalledWith(PILOT_ID, ADMIN_ID);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: PILOT_ID, suspended: true, email: "mira@example.com" });
  });

  it("maps an ADMIN target to 409", async () => {
    suspendMock.mockRejectedValue(new AdminCannotBeSuspendedError(2));

    const response = await suspendRoute(
      request("http://localhost/api/v1/users/2/suspend"),
      idContext("2"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      data: null,
      status: "CONFLICT",
      message: "User 2 is an admin and cannot be suspended",
    });
  });

  it("maps an unknown id to 404", async () => {
    suspendMock.mockRejectedValue(new UserNotFoundError(999));

    const response = await suspendRoute(
      request("http://localhost/api/v1/users/999/suspend"),
      idContext("999"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a non-admin with 403 and never reaches the service", async () => {
    const response = await suspendRoute(
      request(`http://localhost/api/v1/users/${PILOT_ID}/suspend`, 7, "DESIGNER"),
      idContext(String(PILOT_ID)),
    );

    expect(response.status).toBe(403);
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/users/3/suspend"), { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/v1/users/{id}/reactivate", () => {
  it("passes the target and the acting admin, and answers 200 with the updated UserResponse", async () => {
    reactivateMock.mockResolvedValue(fakeUser({ suspended: false }));

    const response = await reactivateRoute(
      request(`http://localhost/api/v1/users/${PILOT_ID}/reactivate`),
      idContext(String(PILOT_ID)),
    );
    const body = await response.json();

    expect(reactivateMock).toHaveBeenCalledWith(PILOT_ID, ADMIN_ID);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: PILOT_ID, suspended: false });
  });

  it("has no ADMIN-target rejection — reactivating one is the service's no-op, still a 200", async () => {
    const admin = fakeUser({ id: 2, username: "root", role: "ADMIN", suspended: false });
    reactivateMock.mockResolvedValue(admin);

    const response = await reactivateRoute(
      request("http://localhost/api/v1/users/2/reactivate"),
      idContext("2"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 2, role: "ADMIN" });
  });

  it("maps an unknown id to 404", async () => {
    reactivateMock.mockRejectedValue(new UserNotFoundError(999));

    const response = await reactivateRoute(
      request("http://localhost/api/v1/users/999/reactivate"),
      idContext("999"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a non-admin with 403 and never reaches the service", async () => {
    const response = await reactivateRoute(
      request(`http://localhost/api/v1/users/${PILOT_ID}/reactivate`, PILOT_ID, "PILOT"),
      idContext(String(PILOT_ID)),
    );

    expect(response.status).toBe(403);
    expect(reactivateMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/users/3/reactivate"), { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });
});
