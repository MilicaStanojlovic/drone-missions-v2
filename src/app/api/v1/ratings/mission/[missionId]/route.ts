import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/guards";
import { toRatingResponse, type RatingResponse } from "@/features/ratings/server/rating.mapper";
import { ratingRequestSchema } from "@/features/ratings/server/rating.schema";
import { create, forMission } from "@/features/ratings/server/rating.service";

/**
 * `POST` / `GET /api/v1/ratings/mission/{missionId}` (replace
 * `RatingController.rate` and `RatingController.forMission`).
 *
 * Both verbs are `@PreAuthorize("isAuthenticated()")` and nothing more — the
 * distinguishing feature of this controller against every other one in the
 * source. There is **no role gate on either handler**, and that is deliberate
 * rather than an omission: both sides of a mission rate each other, so a rule
 * like `hasRole('PILOT')` (which guards the bid endpoints) would lock out half
 * of every exchange. `src/middleware.ts` already enforces the authentication
 * part for this path — it is not in `PUBLIC_PATHS` — so neither handler below
 * carries a `requireRole()` call.
 *
 * What replaces the role gate is a *participation* gate, and it is a property
 * of the mission rather than of the endpoint, so it lives one layer down in
 * `RatingService`, which is where the mission row is loaded:
 *
 * - the mission must exist -> `MissionNotFoundError` -> 404;
 * - it must have reached COMPLETED -> `RatingNotYetAllowedError` -> 409;
 * - the rater must not have rated it already -> `AlreadyRatedError` -> 409;
 * - the caller must be its designer or its awarded pilot ->
 *   `NotMissionParticipantError` -> 403 (on `GET` too: the pair of ratings on
 *   a mission is a private exchange between its two sides).
 *
 * `withErrorHandling()` maps all four, so the handlers stay parse -> validate
 * -> service -> shape. Note in particular what `POST` does *not* take: the
 * ratee is never a request field. It is derived from the mission by
 * `RatingService.counterpartOf`, so no payload can address a rating at a
 * stranger.
 *
 * `GET /api/v1/ratings/user/{userId}` — the profile half of this controller —
 * lives in `ratings/user/[userId]/route.ts`.
 *
 * SOURCE: drone-missions-backend/.../web/controller/rating/RatingController.java
 * (`rate`, `forMission`)
 */

/** The dynamic segment this route file owns. */
type RatingMissionRouteContext = { params: Promise<{ missionId: string }> };

/**
 * The path variable, validated the way `@PathVariable Long missionId` is:
 * Spring converts it and answers 400 (`MethodArgumentTypeMismatchException`)
 * when the segment is not a number. Parsing it through Zod puts that same
 * rejection on `withErrorHandling()`'s validation branch — the mechanism this
 * port uses for every bad parameter — and keeps the wording identical to
 * `bids/mission/[missionId]/route.ts`, whose schema this mirrors including its
 * safe-integer bound (the JS counterpart of `Long`'s range: an id past
 * `2^53 - 1` cannot round-trip through a JS number, and the row it would name
 * cannot exist, since the column is an identity `bigint` starting at 1).
 */
const missionIdSchema = z.object({
  missionId: z
    .string()
    .regex(/^-?\d+$/, "must be a number")
    .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
    .transform(Number),
});

/**
 * Parses `{missionId}` out of the matched route segment. Wrapped in an object
 * schema so the rejection reaches the client keyed as `missionId` — the
 * closest equivalent of the source's
 * `Invalid value for parameter 'missionId'`.
 */
async function missionId(context: RatingMissionRouteContext): Promise<number> {
  return missionIdSchema.parse(await context.params).missionId;
}

/**
 * Rates the other side of a completed mission. Mirrors
 * `RatingController.rate`.
 *
 * Answers **200**, not 201, because the source returns
 * `ResponseEntity.ok(...)` and produces no `Location` header — the same choice
 * `POST /api/v1/bids/mission/{missionId}` already reflects. The two POSTs in
 * this port that *do* answer 201 (`/api/v1/missions`, `/api/v1/auth/register`)
 * answer it because their controllers explicitly build a `201 Created`
 * response; this one does not, so mirroring the source and matching the
 * established convention agree here.
 *
 * The rater is the caller: `caller.id` comes off the headers `middleware.ts`
 * attaches from the verified token's `sub` claim — the analogue of
 * `@AuthenticationPrincipal Long userId` — so a rating can never be attributed
 * to somebody else by way of the body or the query string.
 *
 * `comment` reaches the service as `undefined` when it was omitted, null, or
 * blank (`rating.schema.ts` normalises all three to "no comment"); the service
 * writes the `NULL` the nullable column expects.
 */
export const POST = withErrorHandling<RatingMissionRouteContext>(async (request, context) => {
  const id = await missionId(context);
  const caller = getCurrentUser(request);
  const body = await request.json();
  const { score, comment } = ratingRequestSchema.parse(body);

  const rating = await create(id, caller.id, score, comment);
  return NextResponse.json<RatingResponse>(toRatingResponse(rating));
});

/**
 * Both ratings on a mission, newest first, so a participant can see whether
 * they have rated yet — and read the one they were given. Mirrors
 * `RatingController.forMission`.
 *
 * At most two rows come back (one per side, by `rating_mission_rater_unique`),
 * and only for the mission's two participants; anyone else gets a 403 from the
 * service rather than an empty list, since "there are no ratings here" and
 * "you may not see them" are different answers.
 */
export const GET = withErrorHandling<RatingMissionRouteContext>(async (request, context) => {
  const id = await missionId(context);
  const caller = getCurrentUser(request);

  const ratings = await forMission(id, caller.id);
  return NextResponse.json<RatingResponse[]>(ratings.map(toRatingResponse));
});
