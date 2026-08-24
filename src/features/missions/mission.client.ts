import { apiFetch } from "@/features/auth/auth.client";
import { ensureOk } from "@/lib/api/client";
import type { PagedModel } from "@/lib/api/paging";
import type { MissionResponse } from "@/features/missions/server/mission.mapper";
import type { Geofence, MissionStatus, Waypoint, WaypointAction } from "@/features/missions/mission.types";

/**
 * Client-side mission access: the browser-facing mirror of the missions
 * feature. Replaces `services/mission.service.ts` (the HTTP calls) plus the
 * display constants of `models/mission.model.ts` that the map and the
 * waypoint dialog render.
 *
 * Why a separate module rather than importing the domain ones: every module
 * under `features/missions/` except this one starts with `import
 * "server-only"` (`mission.types.ts`, `mission.schema.ts`, `mission.mapper.ts`,
 * ...), which throws the moment its code is pulled into a client bundle. The
 * *types* from those modules are still safe to reuse, because `import type`
 * is erased at compile time and emits no runtime import — the same technique
 * `features/auth/auth.client.ts` uses for `UserRole`. So the shapes below are
 * derived from the server DTO rather than hand-copied (no second source of
 * truth to drift), while the runtime constants are declared here.
 *
 * There is no HttpClient/interceptor layer in this stack: every call goes
 * through `apiFetch`, which attaches the Bearer token and handles session
 * expiry exactly as `authInterceptor` did.
 *
 * Only the endpoints this phase's API exposes are ported. `getMyJobs` and
 * `start`/`complete`/`cancel` joined in Phase 5, with the lifecycle routes
 * that back them; `adminList` and `hide`/`unhide`/`remove` joined in Phase 7,
 * with the moderation routes (`GET /missions/all`, `POST /missions/{id}/hide`,
 * `.../unhide`, `.../remove`) that back them.
 *
 * SOURCE:
 * - drone-missions-frontend/.../services/mission.service.ts
 * - drone-missions-frontend/.../models/mission.model.ts
 */

/**
 * The JSON wire form of a server type: `Date`-typed fields of a DTO arrive at
 * the browser as ISO-8601 strings (that is what `NextResponse.json` writes and
 * `response.json()` reads back), everything else is unchanged. Mirrors how the
 * Angular `Mission` model types the backend's `Instant` fields as `string`.
 */
type IsoDates<T> = {
  [K in keyof T]: [Extract<T[K], Date>] extends [never] ? T[K] : Exclude<T[K], Date> | string;
};

/**
 * One mission as the API returns it — `MissionResponse` with its `startTime`,
 * `endTime`, `createdAt` and `updatedAt` as ISO strings. Ports the Angular
 * `Mission` interface; deriving it from the response DTO is what keeps the two
 * in step when a later phase adds a field.
 */
export type Mission = IsoDates<MissionResponse>;

/**
 * The body `POST`/`PUT /api/v1/missions` accept — the wire form of
 * `missionRequestSchema`'s input (which is `MissionRequest` field for field).
 * Ports the Angular `MissionPayload`: the server assigns `id`, ownership,
 * moderation and the timestamps, so none of them are client-supplied.
 *
 * `startTime`/`endTime` are ISO-8601 instants and `biddingDeadline` a
 * `yyyy-MM-dd` calendar date, exactly as the schema parses them.
 */
export interface MissionPayload {
  name: string;
  description?: string | null;
  status: MissionStatus;
  startTime: string;
  endTime: string;
  location?: string | null;
  biddingDeadline?: string | null;
  waypoints: Waypoint[];
  geofence?: Geofence | null;
}

/** Optional server-side filters for the open feed. `date` is a `yyyy-MM-dd` string. */
export interface FeedFilters {
  location?: string;
  keyword?: string;
  date?: string;
}

/**
 * Optional filters for the admin all-missions listing. `page` is 0-based, and
 * `q` is matched server-side against the mission name *or* the designer's
 * username. Mirrors the inline parameter object of `MissionService.adminList`.
 */
export interface AdminMissionQuery {
  q?: string;
  page?: number;
}

/**
 * Every status, in lifecycle order — the browser-side twin of `MISSION_STATUSES`
 * in `src/db/schema.ts`, declared here rather than imported so that pulling a
 * status list into a client bundle does not pull `drizzle-orm/pg-core` in with
 * it (the same reason the maps below are declared and not derived). Mirrors
 * `MISSION_STATUSES` in `models/mission.model.ts`, which the admin overview's
 * status bars iterate; `satisfies` makes the compiler check the two lists
 * against the union rather than trusting this copy.
 *
 * Unlike `MISSION_LIFECYCLE` this includes `CANCELLED` — a bar chart counts
 * every bucket, where a progress timeline walks only the happy path.
 */
export const MISSION_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "BIDDING",
  "AWARDED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const satisfies readonly MissionStatus[];

/** Human-friendly labels for display (badges, detail view). */
export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  BIDDING: "Bidding",
  AWARDED: "Awarded",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/**
 * The happy-path status order a mission moves through, for the detail page's
 * progress timeline. `CANCELLED` is deliberately absent — it is an exit, not a
 * step, and the timeline renders it by marking nothing reached. Mirrors
 * `MISSION_LIFECYCLE` in `models/mission.model.ts`.
 */
export const MISSION_LIFECYCLE: readonly MissionStatus[] = [
  "DRAFT",
  "PUBLISHED",
  "BIDDING",
  "AWARDED",
  "IN_PROGRESS",
  "COMPLETED",
];

/**
 * Accent colour per status — lifted from the DroneMissions design system
 * (every value below also appears in `design/DroneMissions.dc.html`).
 */
export const MISSION_STATUS_COLORS: Record<MissionStatus, string> = {
  DRAFT: "#64748b",
  PUBLISHED: "#0e9bb5",
  BIDDING: "#d9860a",
  AWARDED: "#7c5cff",
  IN_PROGRESS: "#2f6bff",
  COMPLETED: "#12a06a",
  CANCELLED: "#e04a3f",
};

/** Human-friendly labels for display (waypoint dialog, map tooltips). */
export const WAYPOINT_ACTION_LABELS: Record<WaypointAction, string> = {
  PHOTO: "Take a picture",
  START_RECORDING: "Start recording",
  STOP_RECORDING: "Stop recording",
  HOVER: "Hover",
};

/**
 * Glyph per action, as the inner markup of a 24×24 stroked `<svg>` — the map
 * marker badge supplies the wrapper, size and colour (`currentColor`).
 */
export const WAYPOINT_ACTION_ICONS: Record<WaypointAction, string> = {
  PHOTO: '<path d="M4 8.5h3.2L9 6h6l1.8 2.5H20v10H4z" /><circle cx="12" cy="13" r="3" />',
  START_RECORDING: '<circle cx="12" cy="12" r="5.5" fill="currentColor" stroke="none" />',
  STOP_RECORDING:
    '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />',
  HOVER: '<circle cx="12" cy="12" r="7.5" /><path d="M12 7.5V12l3 1.8" />',
};

/**
 * The API error envelope and the `Error` that carries it. Both moved to
 * `@/lib/api/client` in Phase 3, when `bid.client.ts` became the second caller
 * of the same endpoints' error shape — a second `ApiError` *class* would break
 * `instanceof` for whichever module did not declare it. Re-exported here so
 * this module stays the one import site for mission-facing client code.
 */
export { ApiError, type ApiErrorBody } from "@/lib/api/client";

const BASE_URL = "/api/v1/missions";

/**
 * The open marketplace — every mission the backend exposes to all users
 * (PUBLISHED / BIDDING), optionally narrowed by location / keyword / date.
 * Blank filters are omitted from the query string entirely, mirroring
 * `MissionService.getAll`'s `?.trim()` guards (an empty filter means
 * unfiltered, not "match the empty string").
 */
export async function fetchOpenMissions(filters: FeedFilters = {}): Promise<Mission[]> {
  const params = new URLSearchParams();
  if (filters.location?.trim()) {
    params.set("location", filters.location.trim());
  }
  if (filters.keyword?.trim()) {
    params.set("keyword", filters.keyword.trim());
  }
  if (filters.date) {
    params.set("date", filters.date);
  }
  const query = params.toString();
  const response = await ensureOk(await apiFetch(query ? `${BASE_URL}?${query}` : BASE_URL));
  return (await response.json()) as Mission[];
}

/**
 * Admin: one page of *every* mission on the platform, whatever its status or
 * moderation state, newest first. Mirrors `adminList`, including its two
 * omissions: page 0 and a blank `q` are left out of the query string entirely
 * rather than sent as `page=0`/`q=` (an absent `q` is what the server reads as
 * "everything"), and `q` is trimmed before it travels.
 */
export async function fetchAllMissions(
  query: AdminMissionQuery = {},
): Promise<PagedModel<Mission>> {
  const params = new URLSearchParams();
  if (query.page && query.page > 0) {
    params.set("page", String(query.page));
  }
  if (query.q?.trim()) {
    params.set("q", query.q.trim());
  }
  const search = params.toString();
  const response = await ensureOk(
    await apiFetch(search ? `${BASE_URL}/all?${search}` : `${BASE_URL}/all`),
  );
  return (await response.json()) as PagedModel<Mission>;
}

/**
 * Admin: take a mission out of the pilot feed (VISIBLE → HIDDEN). Mirrors
 * `hide`.
 *
 * Reversible, and the designer keeps the mission — which is why the UI
 * confirms it with softer wording than `removeMission` below. The empty `{}`
 * body Angular sends is dropped for the same reason as the lifecycle calls:
 * the route takes its whole input from the path plus the caller's token.
 */
export async function hideMission(id: number): Promise<Mission> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/${id}/hide`, { method: "POST" }));
  return (await response.json()) as Mission;
}

/** Admin: return a hidden mission to the feed (HIDDEN → VISIBLE). Mirrors `unhide`. */
export async function unhideMission(id: number): Promise<Mission> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/${id}/unhide`, { method: "POST" }));
  return (await response.json()) as Mission;
}

/**
 * Admin: permanently delete the mission — its bids, notifications and ratings
 * cascade with it (204, no body). Mirrors `remove`.
 *
 * A POST, not a DELETE: `DELETE /missions/{id}` is the designer's own
 * ownership-checked delete, and the source gives moderation its own verb-named
 * endpoint rather than overloading that one.
 */
export async function removeMission(id: number): Promise<void> {
  await ensureOk(await apiFetch(`${BASE_URL}/${id}/remove`, { method: "POST" }));
}

/** Only the missions created by the current user. Mirrors `getMine`. */
export async function fetchMyMissions(): Promise<Mission[]> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/my-missions`));
  return (await response.json()) as Mission[];
}

/**
 * The missions awarded to the current pilot ("my jobs"). Mirrors `getMyJobs`.
 *
 * PILOT-only on the server (the source guards it with `hasRole('PILOT')`
 * where `/my-missions` only wants an authenticated caller), so a designer
 * calling this gets a 403 rather than an empty list.
 */
export async function fetchMyJobs(): Promise<Mission[]> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/my-jobs`));
  return (await response.json()) as Mission[];
}

/**
 * The awarded pilot starts their mission (AWARDED → IN_PROGRESS). Mirrors
 * `start`.
 *
 * The empty `{}` body Angular sends is dropped throughout the three lifecycle
 * calls below: `HttpClient.post` requires a body argument where `fetch` does
 * not, and each route takes its whole input from the path plus the caller's
 * token, so there is nothing to send.
 *
 * Starting is always a deliberate action — nothing anywhere in this port
 * promotes a mission to IN_PROGRESS merely because its `startTime` passed, so
 * this call is the only way the badge moves (see `mission.service.ts`).
 */
export async function startMission(id: number): Promise<Mission> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/${id}/start`, { method: "POST" }));
  return (await response.json()) as Mission;
}

/** The awarded pilot marks a mission finished (IN_PROGRESS → COMPLETED). Mirrors `complete`. */
export async function completeMission(id: number): Promise<Mission> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/${id}/complete`, { method: "POST" }));
  return (await response.json()) as Mission;
}

/**
 * The mission's creator cancels it (→ CANCELLED), rejecting any outstanding
 * bids. Mirrors `cancel`.
 *
 * Like `accept`, the cascade behind it (every pending *and* accepted bid
 * rejected, the awarded pilot notified) is not in the response, which is why
 * callers re-read mission *and* bids afterwards rather than trusting the
 * returned mission alone.
 */
export async function cancelMission(id: number): Promise<Mission> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/${id}/cancel`, { method: "POST" }));
  return (await response.json()) as Mission;
}

/** One mission by id. Mirrors `getById`. */
export async function fetchMission(id: number): Promise<Mission> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/${id}`));
  return (await response.json()) as Mission;
}

/** Creates a mission (201). Mirrors `create`. */
export async function createMission(payload: MissionPayload): Promise<Mission> {
  const response = await ensureOk(
    await apiFetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return (await response.json()) as Mission;
}

/** Replaces a mission the caller owns. Mirrors `update`. */
export async function updateMission(id: number, payload: MissionPayload): Promise<Mission> {
  const response = await ensureOk(
    await apiFetch(`${BASE_URL}/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return (await response.json()) as Mission;
}

/** Deletes a mission the caller owns (204, no body). Mirrors `delete`. */
export async function deleteMission(id: number): Promise<void> {
  await ensureOk(await apiFetch(`${BASE_URL}/${id}`, { method: "DELETE" }));
}
