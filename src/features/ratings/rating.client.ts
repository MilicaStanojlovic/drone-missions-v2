import { apiFetch } from "@/features/auth/auth.client";
import { ensureOk } from "@/lib/api/client";
import type { RatingResponse, UserRatingsResponse } from "@/features/ratings/server/rating.mapper";

/**
 * Client-side rating access: the browser-facing mirror of the ratings feature.
 * Replaces `services/rating.service.ts`.
 *
 * Why a separate module rather than calling the service directly: every other
 * runtime module under `features/ratings/` (`rating.service.ts`,
 * `rating.queries.ts`, `rating.mapper.ts`, `rating.schema.ts`) starts with
 * `import "server-only"` and throws the moment its code is pulled into a
 * client bundle. The *types* are still safe to reuse, because `import type` is
 * erased at compile time and emits no runtime import — the same technique
 * `bid.client.ts` and `mission.client.ts` use for `BidResponse` /
 * `MissionResponse`. So the shapes below are derived from the server DTO
 * rather than hand-copied from the Angular models, and there is no second
 * source of truth to drift.
 *
 * There is no HttpClient/interceptor layer in this stack: every call goes
 * through `apiFetch`, which attaches the Bearer token and handles session
 * expiry exactly as `authInterceptor` did, and `ensureOk` turns a 4xx/5xx into
 * the `ApiError` that carries the server's `{ data, status, message }`
 * envelope (`fetch` resolves for those, where HttpClient throws). That is what
 * lets the rate form surface the server's own 409 text ("You have already
 * rated mission 7") instead of a generic failure.
 *
 * The source's three methods return cold Observables — "subscription (and
 * therefore the HTTP call) is the caller's responsibility". A Promise is hot,
 * so the call starts here; every caller in the original subscribes
 * immediately, so no behaviour depends on the difference.
 *
 * SOURCE: drone-missions-frontend/.../services/rating.service.ts
 */

/**
 * One rating as the API returns it — `RatingResponse` with its `createdAt` as
 * an ISO-8601 string, which is what `NextResponse.json` writes and
 * `response.json()` reads back. Mirrors how the Angular `Rating` model types
 * the backend's `Instant` field as `string`.
 *
 * There is no `updatedAt` to convert: a rating is written once and never
 * changed.
 */
export type Rating = Omit<RatingResponse, "createdAt"> & { createdAt: string };

/**
 * A user's reputation as `GET /api/v1/ratings/user/{id}` returns it — the
 * headline `average`/`count` plus the received ratings. Ports the Angular
 * `UserRatings` (which extends its `RatingSummary` with `ratings`); derived
 * here from the server DTO so the two stay in step.
 */
export type UserRatings = Omit<UserRatingsResponse, "ratings"> & { ratings: Rating[] };

/**
 * The body `POST /api/v1/ratings/mission/{missionId}` accepts — the wire form
 * of `ratingRequestSchema`'s input, which is `RatingRequest` field for field.
 * Ports the Angular `RatingPayload`: the server derives the rater from the
 * token, the ratee from the mission's other participant, and assigns the id
 * and timestamp, so none of them are client-supplied.
 */
export interface RatingPayload {
  score: number;
  comment?: string;
}

const BASE_URL = "/api/v1/ratings";

/**
 * Rates the other side of a completed mission. Mirrors `rate`.
 *
 * The server picks the counterpart (designer -> awarded pilot, pilot ->
 * designer), so the payload carries no ratee. Rejects with an `ApiError`
 * carrying the server's message on 409 (already rated, or the mission is not
 * COMPLETED yet), 403 (not a participant) and 404 (no such mission) — the
 * three the rate form surfaces.
 *
 * Answers 200 rather than 201, matching the route (and `RatingController`,
 * which returns a plain `ResponseEntity.ok`).
 */
export async function rateMission(missionId: number, payload: RatingPayload): Promise<Rating> {
  const response = await ensureOk(
    await apiFetch(`${BASE_URL}/mission/${missionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return (await response.json()) as Rating;
}

/**
 * Both ratings on a mission, newest first — participants only (the server
 * answers 403 to anyone else). Mirrors `forMission`.
 */
export async function fetchRatingsForMission(missionId: number): Promise<Rating[]> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/mission/${missionId}`));
  return (await response.json()) as Rating[];
}

/** A user's average, count and comments. Mirrors `forUser`. */
export async function fetchRatingsForUser(userId: number): Promise<UserRatings> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/user/${userId}`));
  return (await response.json()) as UserRatings;
}
