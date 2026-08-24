import { afterEach, describe, expect, it, vi } from "vitest";
import type { MissionDao } from "@/features/missions/server/mission.cache";
import type { Page, PageRequest } from "@/lib/api/paging";
import type { NewAuditEntry } from "@/lib/audit";
import type { User } from "@/features/users/user.types";
import { UserNotFoundError } from "@/features/users/server/user.queries";

/**
 * Vitest suite for `user.service.ts`.
 *
 * Two groups, from two different sources:
 *
 * **`findById`** (Phase 1). There is no dedicated `me` case in the source
 * `UserControllerTest`, so this group mirrors the *composition*
 * `UserController.me` performs — `mapper.toResponse(userService.findById(userId))`
 * — by asserting `findById` delegates to the query layer and propagates its
 * `UserNotFoundError` unchanged, the same way the source's
 * `UserService.findById` delegates to `UserRepository` and lets
 * `UserNotFoundException` propagate out of the service layer.
 *
 * **`search`/`suspend`/`reactivate`** (Phase 7). Mirrors all six cases of
 * `UserServiceTest` one-for-one: `searchDelegatesTheRoleFilterAndPageable`,
 * `suspendWritesAndRecordsTheAdminWhoDidIt`,
 * `suspendingAnAlreadySuspendedUserRecordsNothing`,
 * `suspendingAnAdminIsRejectedAndRecordsNothing`,
 * `reactivateWritesAndRecordsTheAdminWhoDidIt` and
 * `reactivatingAnActiveUserRecordsNothing` — each named below after the case it
 * ports. Where the Java test asserts on the mutated entity
 * (`assertThat(target.isSuspended()).isTrue()` — JPA dirty-checking flushes the
 * field), this port has no entity to mutate: `setSuspended` is a targeted
 * `UPDATE` (see `user.queries.ts`), so the equivalent assertion is that it was
 * called with the right flag and that its returned row is what the service
 * hands back.
 *
 * Three collaborators are mocked, matching the Java test's three `@Mock`s:
 * `user.queries.ts` stands in for `UserRepository`, `mission.cache.ts`'s DAO for
 * `MissionDao`, and `record()` for `AuditService`. `@/lib/audit` is only
 * *partially* mocked — `record()` (the DB write) is a spy while the real
 * `userSuspended`/`userReactivated` factories run — so the captured entry proves
 * the service audits the right shape, the same trick `mission.service.test.ts`
 * uses. That is what lets the two "records nothing" cases below be as strict as
 * the Java `verify(..., never())` pair.
 *
 * The two no-op cases additionally assert `invalidateLists` was NOT called.
 * The Java test does not check that (it only verifies the repository and the
 * audit service), but it follows from the source all the same: the invalidation
 * sits inside the very `if` block those cases skip, and a cache flush on every
 * redundant button press is exactly the kind of regression a no-op test should
 * catch.
 *
 * Live-DB route-level integration coverage of `GET /api/v1/users/me` itself
 * (own profile, anonymous -> 401, deleted-id -> 404) lives in
 * `src/app/api/v1/users/me/route.test.ts`, mirroring the split between this
 * file and `src/app/api/v1/auth/routes.test.ts`.
 *
 * The three collaborators being mocked is also this suite's blind spot, and
 * two live-DB suites cover it: `user.queries.test.ts` for the SQL beneath
 * `search`/`setSuspended`, and `src/app/api/v1/users/routes.live.test.ts` for
 * the whole admin surface over real rows — including the one rule no mock can
 * show, that `invalidateLists()` really does drop a suspended designer's
 * missions out of a warm marketplace cache.
 *
 * SOURCE:
 * - drone-missions-backend/.../src/test/.../business/service/user/UserServiceTest.java
 * - drone-missions-backend/.../business/service/user/UserService.java
 * - drone-missions-backend/.../business/exception/user/UserNotFoundException.java
 * - drone-missions-backend/.../business/exception/user/AdminCannotBeSuspendedException.java
 * - drone-missions-backend/.../web/controller/user/UserController.java (`me`)
 */

const findByIdMock = vi.fn();
const searchMock = vi.fn();
const setSuspendedMock = vi.fn();
vi.mock("@/features/users/server/user.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/users/server/user.queries")>();
  return {
    ...actual,
    findById: (...args: unknown[]) => findByIdMock(...args),
    search: (...args: unknown[]) => searchMock(...args),
    setSuspended: (...args: unknown[]) => setSuspendedMock(...args),
  };
});

/**
 * Stands in for the Java test's `@Mock MissionDao`. Only `invalidateLists` is
 * ever reached from this service, but the whole contract is stubbed so the
 * object is a genuine `MissionDao` — a partial one would let a future call to
 * another method fail as `undefined is not a function` instead of being
 * asserted on.
 *
 * `satisfies MissionDao` is what keeps that claim honest: without it the object
 * literal is untyped and a method added to the interface later (as `searchAll`
 * was, by this very phase) would go missing here silently.
 */
const daoMock = {
  findById: vi.fn(),
  findFresh: vi.fn(),
  findOpen: vi.fn(),
  findByUserId: vi.fn(),
  findByAwardedPilotId: vi.fn(),
  findOverdue: vi.fn(),
  searchAll: vi.fn(),
  countByStatus: vi.fn(),
  invalidateLists: vi.fn(),
  invalidate: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
} satisfies MissionDao;
vi.mock("@/features/missions/server/mission.cache", () => ({ getMissionDao: () => daoMock }));

const recordMock = vi.fn();
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, record: (...args: unknown[]) => recordMock(...args) };
});

// `vi.mock` calls above are hoisted by Vitest, so these static imports already
// resolve against the mocked modules.
import { AdminCannotBeSuspendedError, findById, reactivate, search, suspend } from "@/features/users/server/user.service";

/**
 * The Java test's `user(role, suspended)` helper: id 3, username "pilot-mira".
 * Both are load-bearing below — the id is the suspension target and the
 * username is what the audit factories quote into `details`.
 */
function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 3,
    username: "pilot-mira",
    email: "mira@example.com",
    passwordHash: "hash",
    role: "PILOT",
    suspended: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** The single audit entry `record()` was called with. */
function recordedEntry(): NewAuditEntry {
  expect(recordMock).toHaveBeenCalledTimes(1);
  return recordMock.mock.calls[0][0] as NewAuditEntry;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("user.service.ts findById", () => {
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

describe("user.service.ts search", () => {
  // Mirrors `searchDelegatesTheRoleFilterAndPageable`.
  it("delegates the role filter and the page request to the query layer", async () => {
    const request: PageRequest = { page: 0, size: 20 };
    const page: Page<User> = { content: [fakeUser()], request, totalElements: 1 };
    searchMock.mockResolvedValue(page);

    const result = await search("PILOT", request);

    expect(searchMock).toHaveBeenCalledWith("PILOT", request);
    expect(result).toBe(page);
  });

  /**
   * Not a case in the Java suite, but the same delegation across the branch its
   * javadoc calls out ("a null role means everyone"). Worth pinning here
   * because `null` is the value most at risk of being quietly turned into an
   * "everyone" filter — or dropped — on the way through.
   */
  it("passes a null role straight through — the `everyone` filter", async () => {
    const request: PageRequest = { page: 2, size: 50 };
    searchMock.mockResolvedValue({ content: [], request, totalElements: 0 });

    await search(null, request);

    expect(searchMock).toHaveBeenCalledWith(null, request);
  });
});

describe("user.service.ts suspend", () => {
  // Mirrors `suspendWritesAndRecordsTheAdminWhoDidIt`.
  it("writes the suspension, invalidates the feed lists and records the admin who did it", async () => {
    const target = fakeUser({ suspended: false });
    const saved = fakeUser({ suspended: true });
    findByIdMock.mockResolvedValue(target);
    setSuspendedMock.mockResolvedValue(saved);

    const result = await suspend(3, 9);

    expect(setSuspendedMock).toHaveBeenCalledWith(3, true);
    expect(result).toBe(saved);
    expect(daoMock.invalidateLists).toHaveBeenCalledTimes(1);
    const entry = recordedEntry();
    expect(entry.actorId).toBe(9);
    expect(entry.action).toBe("USER_SUSPENDED");
    expect(entry.targetId).toBe(3);
    // Beyond the Java assertions, but produced by the real factory the spy lets
    // run: the row must say ADMIN did it and snapshot the target's username.
    expect(entry.actorRole).toBe("ADMIN");
    expect(entry.targetType).toBe("USER");
    expect(entry.details).toBe('"pilot-mira"');
  });

  // Mirrors `suspendingAnAlreadySuspendedUserRecordsNothing`.
  it("records nothing and writes nothing when the account is already suspended", async () => {
    const target = fakeUser({ suspended: true });
    findByIdMock.mockResolvedValue(target);

    const result = await suspend(3, 9);

    // Idempotent: the endpoint still answers with the current state, so one
    // audit row means one state *change*, not one button press.
    expect(result).toBe(target);
    expect(setSuspendedMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(daoMock.invalidateLists).not.toHaveBeenCalled();
  });

  // Mirrors `suspendingAnAdminIsRejectedAndRecordsNothing`.
  it("rejects an ADMIN target with a 409 and records nothing", async () => {
    findByIdMock.mockResolvedValue(fakeUser({ role: "ADMIN", suspended: false }));

    await expect(suspend(3, 9)).rejects.toBeInstanceOf(AdminCannotBeSuspendedError);

    expect(setSuspendedMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(daoMock.invalidateLists).not.toHaveBeenCalled();
  });

  /**
   * The status the Java type carries via its `ConflictException` base, pinned
   * here because that mapping is what the route layer answers with — the
   * `instanceof` check above alone would still pass if the error were rebased
   * onto a 403.
   */
  it("maps the ADMIN rejection to 409", async () => {
    findByIdMock.mockResolvedValue(fakeUser({ role: "ADMIN" }));

    await expect(suspend(3, 9)).rejects.toMatchObject({ status: 409 });
  });

  /**
   * Not a Java case: there, `findById` throwing `UserNotFoundException` is the
   * shared helper's business and every caller inherits it. Here `suspend` calls
   * this module's own `findById`, so the propagation is worth one assertion —
   * a missing account must be a 404, not a suspension of nothing.
   */
  it("propagates UserNotFoundError for a missing account", async () => {
    findByIdMock.mockRejectedValue(new UserNotFoundError(3));

    await expect(suspend(3, 9)).rejects.toBeInstanceOf(UserNotFoundError);
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("user.service.ts reactivate", () => {
  // Mirrors `reactivateWritesAndRecordsTheAdminWhoDidIt`.
  it("lifts the suspension, invalidates the feed lists and records the admin who did it", async () => {
    const target = fakeUser({ suspended: true });
    const saved = fakeUser({ suspended: false });
    findByIdMock.mockResolvedValue(target);
    setSuspendedMock.mockResolvedValue(saved);

    const result = await reactivate(3, 9);

    expect(setSuspendedMock).toHaveBeenCalledWith(3, false);
    expect(result).toBe(saved);
    expect(daoMock.invalidateLists).toHaveBeenCalledTimes(1);
    const entry = recordedEntry();
    expect(entry.action).toBe("USER_REACTIVATED");
    expect(entry.actorId).toBe(9);
    expect(entry.targetId).toBe(3);
    expect(entry.actorRole).toBe("ADMIN");
    expect(entry.details).toBe('"pilot-mira"');
  });

  // Mirrors `reactivatingAnActiveUserRecordsNothing`.
  it("records nothing and writes nothing when the account is already active", async () => {
    const target = fakeUser({ suspended: false });
    findByIdMock.mockResolvedValue(target);

    const result = await reactivate(3, 9);

    expect(result).toBe(target);
    expect(setSuspendedMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(daoMock.invalidateLists).not.toHaveBeenCalled();
  });

  /**
   * The asymmetry with `suspend` is the source's, and is behavior rather than
   * an oversight: `reactivate` has no ADMIN guard because an admin account can
   * never *become* suspended, so the idempotence check already covers it. If a
   * suspended ADMIN row somehow existed, reactivating it must work — not 409.
   */
  it("has no ADMIN guard: a suspended ADMIN is reactivated rather than rejected", async () => {
    const target = fakeUser({ role: "ADMIN", suspended: true });
    const saved = fakeUser({ role: "ADMIN", suspended: false });
    findByIdMock.mockResolvedValue(target);
    setSuspendedMock.mockResolvedValue(saved);

    const result = await reactivate(3, 9);

    expect(result).toBe(saved);
    expect(setSuspendedMock).toHaveBeenCalledWith(3, false);
    expect(recordedEntry().action).toBe("USER_REACTIVATED");
  });
});
