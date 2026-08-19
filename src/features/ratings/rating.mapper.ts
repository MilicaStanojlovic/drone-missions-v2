import "server-only";
import type { RatingSummary } from "./rating.queries";
import type { Rating } from "./rating.types";

/**
 * Rating DTO mapping (replaces `web.mapper.rating.RatingMapper` and the
 * inline `UserRatingsResponse` assembly in `RatingController.forUser`).
 *
 * The Java mapper's javadoc states the design in one line: "No repositories:
 * the relations carry the names, so the mapper reads them off the entity
 * rather than looking each one up." That holds here too — a `Rating` arrives
 * from `rating.queries.ts` with `mission` and `rater` already resolved by the
 * join, so this module is a pure, synchronous field copy with no data access
 * of its own, exactly like `bid.mapper.ts` (and unlike `mission.mapper.ts`,
 * whose designer-rating summary genuinely has to be fetched).
 *
 * `toResponse` is the mapper's only method; `toUserRatingsResponse` ports the
 * three-line composition `RatingController.forUser` does around it. It lives
 * here rather than in the route handler for the same reason
 * `loadMissionResponses` does: in this stack a handler is a thin parse ->
 * service -> shape function, and "shape" is this module.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/mapper/rating/RatingMapper.java
 * - drone-missions-backend/.../web/dto/rating/RatingResponse.java
 * - drone-missions-backend/.../web/dto/rating/UserRatingsResponse.java
 * - drone-missions-backend/.../web/controller/rating/RatingController.java (`forUser`)
 * - drone-missions-frontend/.../models/rating.model.ts (`Rating`, `UserRatings`)
 */

/**
 * Public view of one rating. Mirrors `RatingResponse` field for field, in the
 * record's declaration order, including its central choice — quoting the
 * record's own javadoc, it "carries the rater and mission display names so the
 * client never shows raw identifiers".
 *
 * `missionName` is `string | null` because `mission.name` is (`varchar(255)`,
 * no NOT NULL), the same nullability `BidResponse.missionName` already
 * reflects; the Angular model types it `string` optimistically.
 *
 * `comment` is `string | null` rather than optional: the source record carries
 * no `@JsonInclude(NON_NULL)` (the only DTO in this codebase that does is
 * `Geofence`), so a rating with no note serializes as `"comment": null` — a
 * present key. The Angular model's `comment?: string` is the permissive
 * reading of that same payload, not a second shape.
 *
 * `score` is a `number` where the record has a `Short`; `rating_score_check`
 * (V11) confines it to 1–5 on either side.
 *
 * `createdAt` is a `Date`, serialized to an ISO-8601 string by the route's
 * JSON response exactly as Jackson renders an `Instant` — the same
 * representation `MissionResponse`/`BidResponse` already use, and what the
 * Angular model's `createdAt: string` receives. There is no `updatedAt`: a
 * rating is written once and never changed.
 */
export interface RatingResponse {
  id: number;
  missionId: number;
  missionName: string | null;
  raterId: number;
  raterName: string;
  rateeId: number;
  score: number;
  comment: string | null;
  createdAt: Date;
}

/**
 * A profile's whole reputation in one payload — "the headline numbers plus
 * what people wrote", as the source record puts it. Mirrors
 * `UserRatingsResponse`, and the Angular `UserRatings` reads these exact keys.
 *
 * `average` and `count` are the two fields of `RatingSummary`, flattened
 * alongside the list rather than nested, because that is how the record
 * declares them and how the client consumes them.
 */
export interface UserRatingsResponse {
  average: number;
  count: number;
  ratings: RatingResponse[];
}

/**
 * Shapes one rating into its public response. Mirrors `RatingMapper.toResponse`
 * field for field.
 *
 * Every field is listed explicitly rather than spread off the row, matching
 * `toBidResponse`/`toMissionResponse`/`toUserResponse`: the rating row carries
 * nothing secret today, but a whitelist cannot start leaking a column a later
 * migration adds — and the two relation objects (`mission`, `rater`) must not
 * reach the wire at all, since the DTO flattens them into
 * `missionName`/`raterName`.
 */
export function toRatingResponse(rating: Rating): RatingResponse {
  return {
    id: rating.id,
    // The mission and rater ids are read off the resolved relations, exactly
    // as the source reads `rating.getMission().getId()` /
    // `rating.getRater().getId()` rather than the FK columns — identical
    // values, but it keeps the mapper honest about what the join is for.
    missionId: rating.mission.id,
    missionName: rating.mission.name,
    raterId: rating.rater.id,
    raterName: rating.rater.username,
    // `ratee` is the one relation the queries deliberately leave unresolved:
    // the DTO emits an id and no ratee name, so the source's
    // `rating.getRatee().getId()` is this FK column and nothing more.
    rateeId: rating.rateeId,
    score: rating.score,
    comment: rating.comment,
    createdAt: rating.createdAt,
  };
}

/**
 * Composes a user's summary and received ratings into the profile payload.
 * Ports the `new UserRatingsResponse(summary.average(), summary.count(),
 * ...map(mapper::toResponse).toList())` expression in
 * `RatingController.forUser`.
 *
 * The summary is passed in rather than derived from `ratings.length`: the two
 * come from different queries in the source (`RatingService.summaryFor` is a
 * SQL aggregate, `receivedBy` a row read), and keeping that split means a
 * caller that already holds a batch summary does not pay for a second
 * aggregate — and that this function stays a pure shape with no data access,
 * like the rest of the module.
 */
export function toUserRatingsResponse(
  summary: RatingSummary,
  ratings: readonly Rating[],
): UserRatingsResponse {
  return {
    average: summary.average,
    count: summary.count,
    ratings: ratings.map(toRatingResponse),
  };
}
