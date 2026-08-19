import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyJwt } from "@/lib/auth/jwt";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";

/**
 * Request authentication (replaces the `SecurityFilterChain` bean in
 * `SecurityConfig`): every `/api/v1/**` request must carry a valid
 * `Authorization: Bearer <jwt>` header, except the two `.permitAll()`
 * endpoints. A missing/invalid/expired token -> 401 with an empty body,
 * mirroring Spring Security's default `BearerTokenAuthenticationEntryPoint`
 * (which runs at the filter layer, before any controller/MVC code runs —
 * same as here, before any route handler runs).
 *
 * On success, the verified token's `sub`/`role` claims are attached to the
 * downstream request as headers (`x-user-id` / `x-user-role`, named in
 * `lib/auth/guards.ts` so both modules agree) — the same information
 * `jwtAuthenticationConverter()` carries onto the request's `Authentication`
 * principal/authorities in the source. `lib/auth/guards.ts`'s
 * `getCurrentUser()` reads them back out.
 *
 * SOURCE:
 * - drone-missions-backend/.../config/SecurityConfig.java (securityFilterChain, jwtAuthenticationConverter)
 * - drone-missions-backend/.../security/UserPrincipal.java
 */

/**
 * The two endpoints `SecurityConfig` marks `.permitAll()`, matched by exact
 * pathname with no HTTP-method restriction — exactly like Spring's
 * `requestMatchers("/api/v1/auth/register", "/api/v1/auth/login")`, which
 * carries no method restriction of its own either (both paths only ever
 * receive `POST` in practice, since that's the only method `AuthController`
 * maps to either one).
 */
const PUBLIC_PATHS = new Set(["/api/v1/auth/register", "/api/v1/auth/login"]);

/** Matches Spring's `DefaultBearerTokenResolver` pattern: `Bearer <token>`, case-insensitive scheme. */
const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) {
    // These two endpoints run with no `getCurrentUser()` call today, but a
    // caller-supplied `x-user-id`/`x-user-role` must never reach a handler
    // unverified — mirrors there being no `Authentication` principal at all
    // on a `.permitAll()` endpoint in the source, spoofed or otherwise.
    const headers = new Headers(request.headers);
    headers.delete(USER_ID_HEADER);
    headers.delete(USER_ROLE_HEADER);
    return NextResponse.next({ request: { headers } });
  }

  const token = request.headers.get("authorization")?.match(BEARER_PREFIX)?.[1];
  if (!token) {
    return unauthenticated();
  }

  try {
    const claims = await verifyJwt(token);
    const headers = new Headers(request.headers);
    headers.set(USER_ID_HEADER, claims.sub);
    headers.set(USER_ROLE_HEADER, claims.role);
    return NextResponse.next({ request: { headers } });
  } catch {
    return unauthenticated();
  }
}

/** 401, no body — mirrors `BearerTokenAuthenticationEntryPoint`'s default response. */
function unauthenticated(): NextResponse {
  return new NextResponse(null, { status: 401 });
}

/** Only run this middleware against the API surface it's meant to guard. */
export const config = {
  matcher: ["/api/v1/:path*"],
};
