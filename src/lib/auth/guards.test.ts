import { describe, expect, it } from "vitest";
import {
  getCurrentUser,
  requireRole,
  RoleNotAllowedError,
  USER_ID_HEADER,
  USER_ROLE_HEADER,
} from "./guards";
import { ForbiddenError } from "@/lib/errors";

/**
 * Vitest suite for `guards.ts`.
 *
 * SOURCE:
 * - drone-missions-backend/.../config/SecurityConfig.java (jwtAuthenticationConverter)
 * - drone-missions-backend/.../security/UserPrincipal.java
 */

function requestWithAuthHeaders(id?: string, role?: string): Request {
  const headers = new Headers();
  if (id !== undefined) headers.set(USER_ID_HEADER, id);
  if (role !== undefined) headers.set(USER_ROLE_HEADER, role);
  return new Request("http://localhost/api/v1/users/me", { headers });
}

describe("getCurrentUser", () => {
  it("reads the id + role middleware.ts attached as headers", () => {
    const request = requestWithAuthHeaders("42", "PILOT");
    expect(getCurrentUser(request)).toEqual({ id: 42, role: "PILOT" });
  });

  it("parses the id header as a number", () => {
    const request = requestWithAuthHeaders("7", "DESIGNER");
    expect(getCurrentUser(request).id).toBe(7);
    expect(typeof getCurrentUser(request).id).toBe("number");
  });

  it("throws when the auth headers are entirely absent (no middleware in front of this route)", () => {
    const request = new Request("http://localhost/api/v1/users/me");
    expect(() => getCurrentUser(request)).toThrow();
  });

  it("throws when only the id header is present", () => {
    const request = requestWithAuthHeaders("42", undefined);
    expect(() => getCurrentUser(request)).toThrow();
  });

  it("throws when only the role header is present", () => {
    const request = requestWithAuthHeaders(undefined, "PILOT");
    expect(() => getCurrentUser(request)).toThrow();
  });
});

describe("requireRole", () => {
  it("does not throw when the caller holds the required role", () => {
    expect(() => requireRole({ id: 1, role: "DESIGNER" }, "DESIGNER")).not.toThrow();
  });

  it("throws RoleNotAllowedError (a ForbiddenError, 403) when the role doesn't match", () => {
    expect(() => requireRole({ id: 1, role: "PILOT" }, "DESIGNER")).toThrow(RoleNotAllowedError);
    try {
      requireRole({ id: 1, role: "PILOT" }, "DESIGNER");
      throw new Error("expected requireRole to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).status).toBe(403);
      expect((error as ForbiddenError).message).toBe(
        "You do not have permission to perform this action",
      );
    }
  });

  it("denies ADMIN just like any other mismatched role (no implicit admin bypass)", () => {
    expect(() => requireRole({ id: 1, role: "ADMIN" }, "PILOT")).toThrow(RoleNotAllowedError);
  });
});
