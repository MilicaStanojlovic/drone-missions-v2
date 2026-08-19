import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "./user.types";
import { UserNotFoundError } from "./user.queries";

/**
 * Vitest suite for `user.service.ts`.
 *
 * There is no dedicated `me` case in the source `UserControllerTest`
 * (only `listPassesFilterAndPageableAndWrapsThePage` and
 * `createAdminPassesThePrincipalAndReturns201`, both Phase 7 admin paths —
 * skipped here per the plan). This suite instead mirrors the *composition*
 * `UserController.me` performs — `mapper.toResponse(userService.findById(userId))`
 * — by asserting `user.service.ts`'s `findById` delegates to the query
 * layer and propagates its `UserNotFoundError` unchanged, the same way the
 * source's `UserService.findById` delegates to `UserRepository` and lets
 * `UserNotFoundException` propagate out of the service layer. `user.queries.ts`
 * is fully mocked, the same way `auth.service.test.ts` mocks it.
 *
 * Live-DB route-level integration coverage of `GET /api/v1/users/me` itself
 * (own profile, anonymous -> 401, deleted-id -> 404) lives in
 * `src/app/api/v1/users/me/route.test.ts`, mirroring the split between this
 * file and `src/app/api/v1/auth/routes.test.ts`.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/controller/user/UserController.java (`me`)
 * - drone-missions-backend/.../business/service/user/UserService.java (`findById`)
 * - drone-missions-backend/.../business/exception/user/UserNotFoundException.java
 * - drone-missions-backend/.../src/test/.../web/controller/user/UserControllerTest.java
 */

const findByIdMock = vi.fn();
vi.mock("./user.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./user.queries")>();
  return { ...actual, findById: (...args: unknown[]) => findByIdMock(...args) };
});

// `vi.mock` calls above are hoisted by Vitest, so this static import already
// resolves against the mocked query module.
import { findById } from "./user.service";

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 3,
    username: "mira",
    email: "mira@example.com",
    passwordHash: "hash",
    role: "PILOT",
    suspended: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("user.service.ts findById", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to the query layer and returns the looked-up user — the lookup half of `me`'s composition", async () => {
    const user = fakeUser({ id: 42 });
    findByIdMock.mockResolvedValue(user);

    const result = await findById(42);

    expect(findByIdMock).toHaveBeenCalledWith(42);
    expect(result).toBe(user);
  });

  it("propagates UserNotFoundError unchanged when no such id exists", async () => {
    findByIdMock.mockRejectedValue(new UserNotFoundError(999));

    await expect(findById(999)).rejects.toBeInstanceOf(UserNotFoundError);
  });
});
