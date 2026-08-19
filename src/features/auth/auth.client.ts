import type { UserRole } from "@/db/schema";

/**
 * Client-side auth state: JWT storage + an API fetch wrapper that attaches
 * the Bearer token and reacts to 401s. Replaces the token-handling half of
 * `auth.service.ts` (`tokenKey`/`storeToken`/`token`/`logout`/`isLoggedIn`/
 * `role`/`claims`) and all of `auth.interceptor.ts` (`authInterceptor`).
 *
 * There is no HttpClient/interceptor layer in this stack — every
 * authenticated client call goes through `apiFetch` below directly instead.
 * The token lives in `localStorage`, so every export here is browser-only;
 * `typeof window === "undefined"` guards make each one an inert no-op
 * during SSR/static generation rather than throwing, since components that
 * call them (see `components/login-form.tsx`, `components/register-form.tsx`,
 * `(app)/layout.tsx`) are themselves client components but still render
 * once on the server.
 *
 * The Angular client talks to a separate origin (`http://localhost:8085`),
 * so `authInterceptor` gates the Bearer-attach step on an `isApiCall`
 * same-origin check. This app serves its own API from the same origin as
 * its pages, so every `apiFetch` call is already an API call — that check
 * has no counterpart here.
 *
 * `import type` for `UserRole` is erased at compile time (no runtime import
 * of `@/db/schema`, which pulls in `drizzle-orm/pg-core`), so this stays
 * safe to import from client components.
 *
 * SOURCE:
 * - drone-missions-frontend/.../services/auth.service.ts
 * - drone-missions-frontend/.../services/auth.interceptor.ts
 * - drone-missions-frontend/.../guards/auth.guard.ts (landingGuard's role-home mapping)
 */

/** localStorage key the JWT is stored under. Mirrors `AuthService`'s `tokenKey`. */
const TOKEN_KEY = "dm_token";

/**
 * Path substring identifying the two public auth endpoints (register/login)
 * — mirrors `authInterceptor`'s `isAuthEndpoint` check. A 401 from either of
 * these is a bad-credentials/validation response the caller (the login
 * form) handles itself, not an expired-session signal, so it must NOT
 * trigger the logout+redirect `apiFetch` otherwise performs.
 */
const AUTH_ENDPOINT_INFIX = "/api/v1/auth/";

/** Reads the stored JWT, or null when logged out (or not in a browser). */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

/** Persists the JWT returned by a successful login. Mirrors `storeToken`. */
export function storeToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

/** Discards the stored JWT. Mirrors the token half of `AuthService.logout`. */
export function clearToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
}

/**
 * Extracts the raw JWT from an `Authorization: Bearer <token>` response
 * header. Mirrors `AuthService.login`'s header parsing exactly, including
 * its fallback of treating a header with no `Bearer ` prefix as the raw
 * token itself.
 */
export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

/**
 * Fetches an API URL with the stored JWT attached as `Authorization:
 * Bearer` (when one is stored), and on a 401 from anywhere other than the
 * auth endpoints, discards the token and sends the browser to `/login` —
 * the same recovery `authInterceptor` performs for an expired/invalid
 * session on every other backend call. Every authenticated client call in
 * the app should go through this instead of bare `fetch`.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(input, { ...init, headers });

  const isAuthEndpoint = input.includes(AUTH_ENDPOINT_INFIX);
  if (response.status === 401 && !isAuthEndpoint) {
    clearToken();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }

  return response;
}

/**
 * Decodes the JWT payload (base64url) into its claims, without verifying
 * the signature (the server does that on every request) — this only reads
 * claims to drive the UI. Returns null for a missing or malformed token.
 * Mirrors `AuthService`'s private `claims()`.
 */
function decodeClaims(): Record<string, unknown> | null {
  const token = getToken();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Logged in = a token that is present and not past its `exp`. Mirrors
 * `AuthService.isLoggedIn`.
 */
export function isLoggedIn(): boolean {
  const claims = decodeClaims();
  if (!claims) return false;
  const exp = claims["exp"];
  return typeof exp !== "number" || exp * 1000 > Date.now();
}

/** Current user's role, read from the token's `role` claim. Mirrors `AuthService.role`. */
export function getRole(): UserRole | null {
  const role = decodeClaims()?.["role"];
  return role === "DESIGNER" || role === "PILOT" || role === "ADMIN" ? role : null;
}

/**
 * Role → landing route, mirroring `landingGuard`'s redirect map exactly
 * (including its fallback: anything that isn't ADMIN or DESIGNER lands on
 * the PILOT home, the same unconditional ternary the source uses). Used by
 * `app/page.tsx` to send a logged-in visitor to their role home instead of
 * the public landing page.
 */
export function roleHomePath(role: UserRole | null): string {
  if (role === "ADMIN") return "/admin/overview";
  return role === "DESIGNER" ? "/missions/mine" : "/missions";
}
