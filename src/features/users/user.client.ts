import { apiFetch } from "@/features/auth/auth.client";
import { ensureOk } from "@/lib/api/client";
import type { PagedModel } from "@/lib/api/paging";
import type { UserRole } from "@/db/schema";
import type { UserResponse } from "@/features/users/user.types";

/**
 * Client-side user access: the browser-facing mirror of the users feature.
 * Replaces `services/user.service.ts` (the HTTP calls) plus the display
 * constants of `models/user.model.ts` that the admin tables render.
 *
 * Why a separate module rather than importing the domain ones: every other
 * runtime module under `features/users/` (`user.service.ts`, `user.queries.ts`,
 * `user.mapper.ts`, `user.schema.ts`, `user.types.ts`) starts with
 * `import "server-only"` and throws the moment its code is pulled into a client
 * bundle. The *types* are still safe to reuse, because `import type` is erased
 * at compile time and emits no runtime import — the same technique
 * `mission.client.ts` and `bid.client.ts` use for their DTOs. So the shapes
 * below are derived from the server DTO rather than hand-copied (no second
 * source of truth to drift), while the runtime constants are declared here.
 *
 * There is no HttpClient/interceptor layer in this stack: every call goes
 * through `apiFetch`, which attaches the Bearer token and handles session
 * expiry exactly as `authInterceptor` did, and `ensureOk` turns a 4xx/5xx into
 * the `ApiError` carrying the server's `{ data, status, message }` envelope
 * (`fetch` resolves for those, where HttpClient throws).
 *
 * Scope note: profile and auth flows stay in `auth.client.ts`, exactly as the
 * source keeps them in `AuthService` — this module exists for the admin views.
 * `GET /api/v1/users/{id}` (the public single-user view) has no caller yet and
 * is deliberately absent rather than stubbed.
 *
 * SOURCE:
 * - drone-missions-frontend/.../services/user.service.ts
 * - drone-missions-frontend/.../models/user.model.ts
 */

/**
 * One account as the admin listing returns it — `UserResponse` with its
 * `createdAt` as an ISO-8601 string, which is what `NextResponse.json` writes
 * and `response.json()` reads back. Mirrors how the Angular `UserResponse`
 * model types the backend's `Instant` as `string`.
 */
export type User = Omit<UserResponse, "createdAt"> & { createdAt: string };

/** Chip labels per role — mirrors `USER_ROLE_LABELS` and the design canvas wording. */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  DESIGNER: "Designer",
  PILOT: "Pilot",
  ADMIN: "Admin",
};

/**
 * Accent colour per role — designer blue, pilot green, admin purple. Mirrors
 * `USER_ROLE_COLORS`; the same three values back the `--role-*` tokens in
 * `globals.css`, declared here as literals because the chips tint their
 * background and border from them (`colour + '1a'` / `+ '55'`), which a CSS
 * variable reference cannot do by string concatenation.
 */
export const USER_ROLE_COLORS: Record<UserRole, string> = {
  DESIGNER: "#2f6bff",
  PILOT: "#12a06a",
  ADMIN: "#6d5ef0",
};

/** Optional filters for the admin user listing. `page` is 0-based. */
export interface UserListQuery {
  role?: UserRole | "";
  page?: number;
}

/**
 * The body `POST /api/v1/users/admins` accepts — the wire form of
 * `newAdminSchema`'s input, which is `NewAdminRequest` field for field. Ports
 * the Angular `NewAdminPayload`: no `role` field, because the server forces
 * ADMIN.
 */
export interface NewAdminPayload {
  username: string;
  email: string;
  password: string;
}

const BASE_URL = "/api/v1/users";

/**
 * One page of accounts, newest first — the backend restricts this to admins.
 * Mirrors `getPage`, including its two omissions: page 0 and a blank role are
 * left out of the query string entirely rather than sent as `page=0`/`role=`
 * (an absent `role` is what the server reads as "everyone").
 */
export async function fetchUsersPage(query: UserListQuery = {}): Promise<PagedModel<User>> {
  const params = new URLSearchParams();
  if (query.page && query.page > 0) {
    params.set("page", String(query.page));
  }
  if (query.role) {
    params.set("role", query.role);
  }
  const search = params.toString();
  const response = await ensureOk(await apiFetch(search ? `${BASE_URL}?${search}` : BASE_URL));
  return (await response.json()) as PagedModel<User>;
}

/**
 * Admin: suspend the account — blocks designing, bidding, awards, execution.
 * Mirrors `suspend`.
 *
 * The empty `{}` body Angular sends is dropped: `HttpClient.post` requires a
 * body argument where `fetch` does not, and the route takes its whole input
 * from the path plus the caller's token, so there is nothing to send.
 */
export async function suspendUser(id: number): Promise<User> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/${id}/suspend`, { method: "POST" }));
  return (await response.json()) as User;
}

/** Admin: lift a suspension. Mirrors `reactivate`. */
export async function reactivateUser(id: number): Promise<User> {
  const response = await ensureOk(
    await apiFetch(`${BASE_URL}/${id}/reactivate`, { method: "POST" }),
  );
  return (await response.json()) as User;
}

/** Admin: register another admin account (role is forced server-side). Mirrors `createAdmin`. */
export async function createAdmin(payload: NewAdminPayload): Promise<User> {
  const response = await ensureOk(
    await apiFetch(`${BASE_URL}/admins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return (await response.json()) as User;
}
