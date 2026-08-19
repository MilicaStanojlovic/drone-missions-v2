import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { middleware, config } from "./middleware";
import { signJwt } from "@/lib/auth/jwt";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import { env } from "@/lib/env";

/**
 * Vitest suite for `middleware.ts`.
 *
 * SOURCE:
 * - drone-missions-backend/.../config/SecurityConfig.java (securityFilterChain, jwtAuthenticationConverter)
 * - drone-missions-backend/.../security/UserPrincipal.java
 */

function requestTo(pathname: string, headers: HeadersInit = {}): NextRequest {
  return new NextRequest(new URL(pathname, "http://localhost"), { headers });
}

/** Reads the header value middleware attached to the *forwarded* request, from the
 * `NextResponse.next({ request: { headers } })` result's own response headers. */
function forwardedHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("middleware — anonymous callers", () => {
  it("rejects an anonymous request to a protected /api/v1/** route with 401 and an empty body", async () => {
    const response = await middleware(requestTo("/api/v1/users/me"));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("rejects a request with a malformed Authorization header", async () => {
    const response = await middleware(
      requestTo("/api/v1/users/me", { authorization: "not-a-bearer-token" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a request with an invalid/garbage bearer token", async () => {
    const response = await middleware(
      requestTo("/api/v1/users/me", { authorization: "Bearer garbage.not.a.jwt" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects an expired token with the same 401", async () => {
    const secretKey = new TextEncoder().encode(env.JWT_SECRET);
    const expiredToken = await new SignJWT({ role: "PILOT" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("1")
      .setIssuedAt(new Date(Date.now() - 60_000))
      .setExpirationTime(new Date(Date.now() - 1_000))
      .sign(secretKey);

    const response = await middleware(
      requestTo("/api/v1/users/me", { authorization: `Bearer ${expiredToken}` }),
    );
    expect(response.status).toBe(401);
  });
});

describe("middleware — permitAll endpoints pass through unauthenticated", () => {
  it("lets an anonymous POST to /api/v1/auth/register through", async () => {
    const response = await middleware(requestTo("/api/v1/auth/register"));
    expect(response.status).not.toBe(401);
  });

  it("lets an anonymous POST to /api/v1/auth/login through", async () => {
    const response = await middleware(requestTo("/api/v1/auth/login"));
    expect(response.status).not.toBe(401);
  });

  it("does not require a token for a nested path under a permitAll prefix that isn't actually exempt", async () => {
    // Exact-pathname match only — mirrors Spring's requestMatchers with no
    // wildcard on these two entries. A sibling path is NOT exempt.
    const response = await middleware(requestTo("/api/v1/auth/register/extra"));
    expect(response.status).toBe(401);
  });

  it("strips a caller-supplied x-user-id/x-user-role instead of forwarding it unverified", async () => {
    const response = await middleware(
      requestTo("/api/v1/auth/register", {
        [USER_ID_HEADER]: "1",
        [USER_ROLE_HEADER]: "ADMIN",
      }),
    );
    expect(response.status).not.toBe(401);
    expect(forwardedHeader(response, USER_ID_HEADER)).toBeNull();
    expect(forwardedHeader(response, USER_ROLE_HEADER)).toBeNull();
  });
});

describe("middleware — valid token attaches id/role to the forwarded request", () => {
  it("forwards the token's sub/role claims as x-user-id / x-user-role headers", async () => {
    const token = await signJwt(42, "PILOT");
    const response = await middleware(
      requestTo("/api/v1/users/me", { authorization: `Bearer ${token}` }),
    );
    expect(response.status).not.toBe(401);
    expect(forwardedHeader(response, USER_ID_HEADER)).toBe("42");
    expect(forwardedHeader(response, USER_ROLE_HEADER)).toBe("PILOT");
  });

  it("accepts the Bearer scheme case-insensitively, matching Spring's DefaultBearerTokenResolver", async () => {
    const token = await signJwt(1, "DESIGNER");
    const response = await middleware(
      requestTo("/api/v1/users/me", { authorization: `bearer ${token}` }),
    );
    expect(response.status).not.toBe(401);
    expect(forwardedHeader(response, USER_ID_HEADER)).toBe("1");
  });

  it("overwrites a caller-supplied x-user-id/x-user-role with the verified token's own claims", async () => {
    const token = await signJwt(42, "PILOT");
    const response = await middleware(
      requestTo("/api/v1/users/me", {
        authorization: `Bearer ${token}`,
        [USER_ID_HEADER]: "1",
        [USER_ROLE_HEADER]: "ADMIN",
      }),
    );
    expect(response.status).not.toBe(401);
    expect(forwardedHeader(response, USER_ID_HEADER)).toBe("42");
    expect(forwardedHeader(response, USER_ROLE_HEADER)).toBe("PILOT");
  });
});

describe("middleware — matcher scope", () => {
  it("only guards /api/v1/**", () => {
    expect(config.matcher).toEqual(["/api/v1/:path*"]);
  });
});
