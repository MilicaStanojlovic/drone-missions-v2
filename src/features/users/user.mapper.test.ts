import { describe, expect, it } from "vitest";
import { toUserResponse } from "./user.mapper";
import type { User } from "./user.types";

/**
 * Vitest suite for `user.mapper.ts` — DB-less coverage proving
 * `toUserResponse` whitelists exactly the `UserResponse` field set and never
 * leaks `passwordHash`/`updatedAt`, even via a future object-spread mistake.
 *
 * SOURCE: drone-missions-backend/.../web/mapper/user/UserMapper.java (`toResponse`)
 */
function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 7,
    username: "mira",
    email: "mira@example.com",
    passwordHash: "$2b$10$abcdefghijklmnopqrstuv",
    role: "PILOT",
    suspended: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

describe("toUserResponse", () => {
  it("carries id/username/email/role/suspended/createdAt through unchanged", () => {
    const user = fakeUser();
    const response = toUserResponse(user);

    expect(response.id).toBe(user.id);
    expect(response.username).toBe(user.username);
    expect(response.email).toBe(user.email);
    expect(response.role).toBe(user.role);
    expect(response.suspended).toBe(user.suspended);
    expect(response.createdAt).toBe(user.createdAt);
  });

  it("exposes exactly the UserResponse key set — no more, no less", () => {
    const response = toUserResponse(fakeUser());
    expect(Object.keys(response).sort()).toEqual(
      ["createdAt", "email", "id", "role", "suspended", "username"].sort(),
    );
  });

  it("never leaks passwordHash", () => {
    const response = toUserResponse(fakeUser());
    expect(response).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(response)).not.toContain("passwordHash");
  });

  it("never leaks updatedAt", () => {
    const response = toUserResponse(fakeUser());
    expect(response).not.toHaveProperty("updatedAt");
  });

  it("reflects a suspended account's flag faithfully", () => {
    const response = toUserResponse(fakeUser({ suspended: true }));
    expect(response.suspended).toBe(true);
  });
});
