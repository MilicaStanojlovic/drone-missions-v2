import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewUser, User } from "@/features/users/user.types";

/**
 * Vitest suite for `auth.service.ts`, mirroring every case in
 * `AuthServiceTest`: `createUserRejectsAdminRole`,
 * `registrationRecordsTheNewUserAsTheActor`, `successfulLoginRecordsTheUser`,
 * `failedLoginRecordsNothing` from Phase 1, plus the two `createAdmin` cases
 * deferred until `createAdmin` itself landed in Phase 7
 * (`createAdminMintsAnAdminAndRecordsTheCreatorAsActor`,
 * `createAdminRejectsADuplicateEmailWithoutSavingOrRecording`).
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
  createAdmin,
  createUser,
  EmailAlreadyExistsError,
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

  describe("createAdmin", () => {
    it("createAdminMintsAnAdminAndRecordsTheCreatorAsActor — role ADMIN, hashed password, ADMIN_CREATED audited to the creator", async () => {
      existsByEmailMock.mockResolvedValue(false);
      hashPasswordMock.mockResolvedValue("hash");
      // `userRepository.save(...)` stamping the generated id onto the entity —
      // so the assertions below read the role and hash the service actually
      // set, rather than ones the stub invented.
      insertUserMock.mockImplementation(async (newUser: NewUser) =>
        fakeUser({ ...newUser, id: 4 }),
      );

      const created = await createAdmin("second-admin", "admin2@example.com", "pw-long-enough", 80);

      // The Java assertions: the minted account is an ADMIN carrying the hash.
      expect(created.role).toBe("ADMIN");
      expect(created.passwordHash).toBe("hash");
      expect(hashPasswordMock).toHaveBeenCalledWith("pw-long-enough");
      // The role is fixed by the service, never taken from a caller argument.
      expect(insertUserMock).toHaveBeenCalledWith({
        username: "second-admin",
        email: "admin2@example.com",
        passwordHash: "hash",
        role: "ADMIN",
      });
      // `ArgumentCaptor<NewAuditEntry>`: the creator is the actor and the new
      // account the target — the one thing that distinguishes this row from
      // the self-actored USER_REGISTERED of ordinary registration.
      expect(recordMock).toHaveBeenCalledTimes(1);
      const entry = recordMock.mock.calls[0][0];
      expect(entry.action).toBe("ADMIN_CREATED");
      expect(entry.actorId).toBe(80);
      expect(entry.targetId).toBe(4);
      expect(entry.targetType).toBe("USER");
      expect(entry.actorRole).toBe("ADMIN");
      expect(entry.details).toBe('"second-admin"');
    });

    it("createAdminRejectsADuplicateEmailWithoutSavingOrRecording — EmailAlreadyExistsError, no insert, no audit", async () => {
      existsByEmailMock.mockResolvedValue(true);

      await expect(
        createAdmin("x", "taken@example.com", "pw-long-enough", 80),
      ).rejects.toBeInstanceOf(EmailAlreadyExistsError);

      expect(existsByEmailMock).toHaveBeenCalledWith("taken@example.com");
      expect(insertUserMock).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
      // The duplicate check precedes the hash, so a rejected request does no
      // bcrypt work either.
      expect(hashPasswordMock).not.toHaveBeenCalled();
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
