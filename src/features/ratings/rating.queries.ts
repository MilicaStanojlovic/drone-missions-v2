import "server-only";
import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { rating } from "@/db/schema";

/**
 * Rating aggregates — the reputation numbers every view of a user shows
 * (replaces `RatingRepository.summariesFor` + the `summariesFor`/`summaryFor`
 * half of `business.service.rating.RatingService`).
 *
 * Phase-2 slice only, and deliberately so: the mission mapper needs a
 * designer's rating on every mission card, which is the *only* rating read
 * this phase has. The full ratings vertical — `create`, `forMission`,
 * `receivedBy`, the rating entity/mapper/routes — is Phase 6, and lands
 * alongside a `rating.service.ts` that will own the write path. Nothing here
 * writes.
 *
 * The two functions live in the query module rather than a service because
 * they are pure aggregate reads with no business rules on top: the Java
 * `RatingService` methods add exactly two things to the repository query —
 * dropping null ids and defaulting an absent user to `NONE` — both of which
 * are properties of the aggregate itself, not policy. A `rating.service.ts`
 * that only re-exported them would be a layer with nothing in it.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/rating/RatingService.java (`summaryFor`, `summariesFor` only)
 * - drone-missions-backend/.../business/service/rating/RatingSummary.java
 * - drone-missions-backend/.../data/repository/RatingRepository.java (`summariesFor` + the `RateeSummary` projection)
 */

/**
 * A user's reputation in the two numbers every view of it needs. Mirrors the
 * `RatingSummary` record: `average` is the mean score (a real number, not
 * rounded — the UI decides how to display it), `count` is how many ratings
 * it averages.
 */
export interface RatingSummary {
  average: number;
  count: number;
}

/**
 * The summary for a user nobody has rated. Mirrors `RatingSummary.NONE`.
 *
 * Frozen because, unlike the immutable Java record it ports, this is a shared
 * object handed to many callers at once — a mutation of it would rewrite
 * every unrated user's reputation.
 */
export const RATING_SUMMARY_NONE: RatingSummary = Object.freeze({ average: 0, count: 0 });

/**
 * One query for a whole page of missions, so feed cards never cost a rating
 * lookup each. Mirrors `RatingService.summariesFor` over
 * `RatingRepository.summariesFor`.
 *
 * Null ids are filtered out and duplicates collapse (the source collects into
 * a `Set`) before the query runs, and an empty input short-circuits without
 * touching the database — a `WHERE ratee_id IN ()` is not valid SQL.
 *
 * Users with no ratings are **absent** from the returned map rather than
 * present as zero, exactly as in the source, so callers decide what "unrated"
 * should look like (`summaryOf` below is that decision for the mission
 * mapper).
 */
export async function summariesFor(
  userIds: readonly (number | null | undefined)[],
): Promise<Map<number, RatingSummary>> {
  const ids = [...new Set(userIds.filter((id): id is number => id !== null && id !== undefined))];
  if (ids.length === 0) {
    return new Map();
  }

  // `avg`/`count` come back from postgres.js as strings (Postgres `numeric`
  // and `bigint` both exceed what a JS number can always represent, so the
  // driver refuses to narrow them). Converting here keeps the string form out
  // of the domain: `average` is a mean of values in [1, 5] and `count` a row
  // count, so both are exactly representable, the same way JPQL hands the
  // Java projection a `Double`/`Long`.
  const rows = await getDb()
    .select({
      rateeId: rating.rateeId,
      average: sql<string>`avg(${rating.score})`,
      total: sql<string>`count(*)`,
    })
    .from(rating)
    .where(inArray(rating.rateeId, ids))
    .groupBy(rating.rateeId);

  return new Map(
    rows.map((row) => [row.rateeId, { average: Number(row.average), count: Number(row.total) }]),
  );
}

/**
 * The summary for a single user. Mirrors `RatingService.summaryFor`,
 * including its null tolerance: `mission.user_id` is nullable for legacy
 * rows created before authentication existed, so "the designer of this
 * mission" is a legitimately absent id and answers `NONE` rather than
 * throwing.
 */
export async function summaryFor(userId: number | null | undefined): Promise<RatingSummary> {
  if (userId === null || userId === undefined) {
    return RATING_SUMMARY_NONE;
  }
  const summaries = await summariesFor([userId]);
  return summaries.get(userId) ?? RATING_SUMMARY_NONE;
}

/**
 * Reads one user's summary out of a batch result, defaulting to `NONE`.
 * Mirrors `MissionController.ratingOf` — a null id (an ownerless legacy
 * mission) never even looks the map up, which on the Java side is what keeps
 * a null key away from the immutable `Map.of()` returned for a page of only
 * such missions.
 */
export function summaryOf(
  summaries: Map<number, RatingSummary>,
  userId: number | null | undefined,
): RatingSummary {
  if (userId === null || userId === undefined) {
    return RATING_SUMMARY_NONE;
  }
  return summaries.get(userId) ?? RATING_SUMMARY_NONE;
}
