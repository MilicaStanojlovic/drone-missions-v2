import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/features/users/user.types";

/**
 * Vitest suite for `auth.service.ts`, mirroring the Phase-1 cases in
 * `AuthServiceTest`: `createUserRejectsAdminRole`,
 * `registrationRecordsTheNewUserAsTheActor`, `successfulLoginRecordsTheUser`,
 * `failedLoginRecordsNothing`. The two `createAdmin` cases
 * (`createAdminMintsAnAdminAndRecordsTheCreatorAsActor`,
 * `createAdminRejectsADuplicateEmailWithoutSavingOrRecording`) are skipped —
 * `createAdmin` has no port yet, it's Phase 7.
 *
 * `user.queries.ts`, `password.ts`, `jwt.ts` are fully mocked, the same way
 * the Java test mocks `UserRepository`/`PasswordEncoder`/`AuthenticationManager`/
 * `JwtEncoder`. `audit.ts` is only *partially* mocked — its `record()` (the
 * actual DB write) is replaced with a spy, but the real `userRegistered`/
 * `userLoggedIn` factories run unmocked, the same way the Java test mocks
 * `AuditService` but not the plain `NewAuditEntry` record it builds — so
 * asserting on the captured entry here proves `auth.service.ts` builds the
 * right audit shape, not just that it calls `record()` at all.
 *
 * Live-DB coverage of `record()` itself lives in `src/lib/audit.test.ts`.
 *
 * SOURCE: drone-missions-backend/.../business/service/auth/AuthServiceTest.java
 */

const existsByEmailMock = vi.fn();
const insertUserMock = vi.fn();
const findByEmailMock = vi.fn();
vi.mock("@/features/users/user.queries", () => ({
  existsByEmail: (...args: unknown[]) => existsByEmailMock(...args),
  insertUser: (...args: unknown[]) => insertUserMock(...args),
  findByEmail: (...args: unknown[]) => findByEmailMock(...args),
}));

const hashPasswordMock = vi.fn();
const verifyPasswordMock = vi.fn();
vi.mock("@/lib/auth/password", () => ({
  hashPassword: (...args: unknown[]) => hashPasswordMock(...args),
  verifyPassword: (...args: unknown[]) => verifyPasswordMock(...args),
}));

const signJwtMock = vi.fn();
vi.mock("@/lib/auth/jwt", () => ({
  signJwt: (...args: unknown[]) => signJwtMock(...args),
}));

const recordMock = vi.fn();
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, record: (...args: unknown[]) => recordMock(...args) };
});

// `vi.mock` calls above are hoisted by Vitest, so this static import already
// resolves against the mocked modules.
import {
  AdminRegistrationNotAllowedError,
  createUser,
  InvalidCredentialsError,
  login,
} from "./auth.service";

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

describe("auth.service.ts", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createUser", () => {
    it("createUserRejectsAdminRole — rejects ADMIN and touches neither the repository nor the audit log", async () => {
      await expect(createUser("eve", "eve@example.com", "pw", "ADMIN")).rejects.toBeInstanceOf(
        AdminRegistrationNotAllowedError,
      );

      expect(existsByEmailMock).not.toHaveBeenCalled();
      expect(insertUserMock).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("registrationRecordsTheNewUserAsTheActor — audits the new user as both actor and target", async () => {
      existsByEmailMock.mockResolvedValue(false);
      hashPasswordMock.mockResolvedValue("hash");
      const inserted = fakeUser({ id: 3, username: "mira", role: "PILOT" });
      insertUserMock.mockResolvedValue(inserted);

      const user = await createUser("mira", "mira@example.com", "pw", "PILOT");

      expect(user).toBe(inserted);
      expect(hashPasswordMock).toHaveBeenCalledWith("pw");
      expect(recordMock).toHaveBeenCalledTimes(1);
      const entry = recordMock.mock.calls[0][0];
      expect(entry.actorId).toBe(3);
      expect(entry.action).toBe("USER_REGISTERED");
      expect(entry.targetType).toBe("USER");
      expect(entry.targetId).toBe(3);
    });
  });

  describe("login", () => {
    it("successfulLoginRecordsTheUser — audits USER_LOGGED_IN with the user as actor", async () => {
      const user = fakeUser({ id: 3, username: "mira", role: "PILOT" });
      findByEmailMock.mockResolvedValue(user);
      verifyPasswordMock.mockResolvedValue(true);
      signJwtMock.mockResolvedValue("token");

      const result = await login("mira@example.com", "pw");

      expect(result).toEqual({ token: "token", user });
      expect(signJwtMock).toHaveBeenCalledWith(3, "PILOT");
      expect(recordMock).toHaveBeenCalledTimes(1);
      const entry = recordMock.mock.calls[0][0];
      expect(entry.action).toBe("USER_LOGGED_IN");
      expect(entry.actorId).toBe(3);
      expect(entry.targetId).toBe(3);
    });

    it("failedLoginRecordsNothing — wrong password: InvalidCredentialsError, no audit, no token", async () => {
      const user = fakeUser({ id: 3, passwordHash: "hash" });
      findByEmailMock.mockResolvedValue(user);
      verifyPasswordMock.mockResolvedValue(false);

      await expect(login("mira@example.com", "wrong")).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      expect(recordMock).not.toHaveBeenCalled();
      expect(signJwtMock).not.toHaveBeenCalled();
    });

    it("failedLoginRecordsNothing — unknown email surfaces the same InvalidCredentialsError, no audit", async () => {
      findByEmailMock.mockResolvedValue(undefined);

      await expect(login("nobody@example.com", "pw")).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      expect(recordMock).not.toHaveBeenCalled();
      expect(verifyPasswordMock).not.toHaveBeenCalled();
      expect(signJwtMock).not.toHaveBeenCalled();
    });
  });
});
