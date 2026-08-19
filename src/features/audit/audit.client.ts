import { apiFetch } from "@/features/auth/auth.client";
import { ensureOk } from "@/lib/api/client";
import type { PagedModel } from "@/lib/api/paging";
import type { AuditAction, AuditActorRole, UserRole } from "@/db/schema";
import type { AuditLogResponse } from "./audit.types";

/**
 * Client-side audit access: the browser-facing mirror of the audit feature.
 * Replaces `services/audit-log.service.ts` (the one HTTP call) plus the display
 * maps of `models/audit.model.ts` that the admin feed renders.
 *
 * Why a separate module rather than importing the domain ones: every other
 * runtime module under `features/audit/` (`audit.service.ts`,
 * `audit.queries.ts`, `audit.mapper.ts`, `audit.schema.ts`, `audit.types.ts`)
 * starts with `import "server-only"` and throws the moment its code is pulled
 * into a client bundle. The *types* are still safe to reuse, because
 * `import type` is erased at compile time and emits no runtime import — the
 * same technique `mission.client.ts` and `user.client.ts` use for their DTOs.
 * So the shape below is derived from the server DTO rather than hand-copied (no
 * second source of truth to drift), while the runtime maps are declared here.
 *
 * The audit trail is read-only over HTTP: every row is written server-side by
 * the feature that performed the action (`src/lib/audit.ts`), so this module
 * has exactly one function, as `AuditLogService` does.
 *
 * SOURCE:
 * - drone-missions-frontend/.../services/audit-log.service.ts
 * - drone-missions-frontend/.../models/audit.model.ts
 */

/**
 * One audit entry as the API returns it — `AuditLogResponse` with its
 * `createdAt` as an ISO-8601 string, which is what `NextResponse.json` writes
 * and `response.json()` reads back. Mirrors how the Angular `AuditLogEntry`
 * model types the backend's `Instant` as `string`.
 */
export type AuditLogEntry = Omit<AuditLogResponse, "createdAt"> & { createdAt: string };

/** Optional server-side filters for the audit listing. `page` is 0-based. */
export interface AuditLogQuery {
  page?: number;
  role?: UserRole | "";
  action?: AuditAction | "";
  q?: string;
}

/**
 * Feed row verb phrase — `details` carries the noun after it, which is why
 * these read "created a mission" and not "created <name>". Mirrors
 * `AUDIT_ACTION_SENTENCES`.
 *
 * PLAN/SOURCE DISCREPANCY, applying to this map and `AUDIT_ACTION_LABELS`
 * below: the Angular `audit.model.ts` is a version behind the backend's
 * `AuditAction` enum. It still lists `MISSION_RESTORED`, which migration V18
 * removed from `audit_log_action_check`, and it is missing `ADMIN_CREATED`,
 * which V17 added and which `src/lib/audit.ts` already writes rows for. The
 * backend enum is the ground truth, so `MISSION_RESTORED` is dropped here and
 * `ADMIN_CREATED` added in its enum position — otherwise the action filter
 * would offer a value the server 400s on while hiding one it can return, and
 * an `ADMIN_CREATED` row would render with an undefined verb phrase. The
 * wording of the new pair follows the map's own conventions (verb phrase with
 * an indefinite article; title-cased noun + past participle).
 */
export const AUDIT_ACTION_SENTENCES: Record<AuditAction, string> = {
  MISSION_CREATED: "created a mission",
  MISSION_UPDATED: "updated a mission",
  MISSION_DELETED: "deleted a mission",
  MISSION_STARTED: "started a mission",
  MISSION_COMPLETED: "completed a mission",
  MISSION_CANCELLED: "cancelled a mission",
  MISSION_HIDDEN: "hid a mission",
  MISSION_UNHIDDEN: "unhid a mission",
  MISSION_REMOVED: "removed a mission",
  BID_PLACED: "placed a bid",
  BID_WITHDRAWN: "withdrew a bid",
  BID_ACCEPTED: "accepted a bid",
  USER_REGISTERED: "registered an account",
  USER_LOGGED_IN: "logged in",
  USER_SUSPENDED: "suspended a user",
  USER_REACTIVATED: "reactivated a user",
  ADMIN_CREATED: "created an admin",
  RATING_CREATED: "left a rating",
};

/**
 * Title-case labels for the action filter select. Mirrors
 * `AUDIT_ACTION_LABELS`; its key order is also the option order the select
 * renders, since the source iterates `Object.keys(AUDIT_ACTION_LABELS)`.
 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  MISSION_CREATED: "Mission created",
  MISSION_UPDATED: "Mission updated",
  MISSION_DELETED: "Mission deleted",
  MISSION_STARTED: "Mission started",
  MISSION_COMPLETED: "Mission completed",
  MISSION_CANCELLED: "Mission cancelled",
  MISSION_HIDDEN: "Mission hidden",
  MISSION_UNHIDDEN: "Mission unhidden",
  MISSION_REMOVED: "Mission removed",
  BID_PLACED: "Bid placed",
  BID_WITHDRAWN: "Bid withdrawn",
  BID_ACCEPTED: "Bid accepted",
  USER_REGISTERED: "User registered",
  USER_LOGGED_IN: "User logged in",
  USER_SUSPENDED: "User suspended",
  USER_REACTIVATED: "User reactivated",
  ADMIN_CREATED: "Admin created",
  RATING_CREATED: "Rating created",
};

/**
 * Every action, in the order the filter select lists them — the source's
 * `Object.keys(AUDIT_ACTION_LABELS) as AuditAction[]`, spelled as a typed
 * derivation so the compiler, not a cast, guarantees the two stay aligned.
 */
export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_LABELS) as AuditAction[];

/**
 * The row dot's colour per *snapshotted* actor role. Declared over
 * `AuditActorRole` rather than reusing `user.client.ts`'s `USER_ROLE_COLORS`
 * because the value being coloured is the audit row's own `actor_role` column
 * (what the actor was when they acted), not the account's current role — the
 * three values coincide, the meaning does not. Mirrors the source's reuse of
 * `USER_ROLE_COLORS` here, with the same designer blue / pilot green / admin
 * purple from the design canvas.
 */
export const AUDIT_ROLE_COLORS: Record<AuditActorRole, string> = {
  DESIGNER: "#2f6bff",
  PILOT: "#12a06a",
  ADMIN: "#6d5ef0",
};

/** Pill labels per actor role — mirrors the source's reuse of `USER_ROLE_LABELS`. */
export const AUDIT_ROLE_LABELS: Record<AuditActorRole, string> = {
  DESIGNER: "Designer",
  PILOT: "Pilot",
  ADMIN: "Admin",
};

/**
 * Pill background/foreground per actor role — the `.pill--designer/pilot/admin`
 * rules of the source stylesheet, as Tailwind classes. These are a *tinted*
 * pair rather than the accent above, so they cannot be derived from
 * `AUDIT_ROLE_COLORS` by string concatenation.
 */
export const AUDIT_ROLE_PILL: Record<AuditActorRole, string> = {
  DESIGNER: "bg-[#eaf0ff] text-[#2f6bff]",
  PILOT: "bg-[#e5f6ee] text-[#0f8c5c]",
  ADMIN: "bg-[#f3f1ff] text-[#6d4ff0]",
};

const BASE_URL = "/api/v1/audit-log";

/**
 * One page of audit entries, newest first — the backend restricts this to
 * admins. Mirrors `getPage`, including its omissions: page 0 and blank
 * `role`/`action`/`q` are left out of the query string entirely rather than
 * sent empty (an absent filter is what the server reads as "everything"), and
 * `q` is trimmed before it travels.
 *
 * `actorId` is not sent by the source's service and so is not offered here —
 * the route accepts it, but no UI produces one.
 */
export async function fetchAuditLogPage(
  query: AuditLogQuery = {},
): Promise<PagedModel<AuditLogEntry>> {
  const params = new URLSearchParams();
  if (query.page && query.page > 0) {
    params.set("page", String(query.page));
  }
  if (query.role) {
    params.set("role", query.role);
  }
  if (query.action) {
    params.set("action", query.action);
  }
  if (query.q?.trim()) {
    params.set("q", query.q.trim());
  }
  const search = params.toString();
  const response = await ensureOk(await apiFetch(search ? `${BASE_URL}?${search}` : BASE_URL));
  return (await response.json()) as PagedModel<AuditLogEntry>;
}
