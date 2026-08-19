import { apiFetch } from "@/features/auth/auth.client";
import type { MissionResponse } from "./mission.mapper";
import type { Geofence, MissionStatus, Waypoint, WaypointAction } from "./mission.types";

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
 * Only the endpoints this phase's API exposes are ported. `getMyJobs`,
 * `adminList`, `start`/`complete`/`cancel` and `hide`/`unhide`/`remove` have
 * no route yet (Phases 5 and 7) and are deliberately absent rather than
 * stubbed against URLs that would 404.
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

/** The `{ data, status, message }` envelope every API error carries (see `withErrorHandling`). */
export interface ApiErrorBody {
  /** A field -> message map for a 400 from a Zod schema; null otherwise. */
  data: unknown;
  status: string;
  message: string;
}

/**
 * A non-2xx API response, thrown by every helper below.
 *
 * This is the stand-in for the `HttpErrorResponse` Angular's HttpClient
 * throws: `fetch` resolves for a 4xx/5xx instead of rejecting, so the parsed
 * error envelope has to be carried on an Error of our own for callers to read
 * the server's field messages out of (the mission form does exactly that).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.message ?? `Request failed with status ${status}`);
    this.name = "ApiError";
  }
}

const BASE_URL = "/api/v1/missions";

/** Rejects a non-2xx response as an `ApiError` carrying the parsed envelope. */
async function ensureOk(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // A response with no JSON body (or a truncated one) still has to surface
    // as the same error type — the status alone is what the caller falls back
    // to, mirroring HttpClient's behaviour for an unparseable error body.
  }
  throw new ApiError(response.status, body);
}

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

/** Only the missions created by the current user. Mirrors `getMine`. */
export async function fetchMyMissions(): Promise<Mission[]> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/my-missions`));
  return (await response.json()) as Mission[];
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
