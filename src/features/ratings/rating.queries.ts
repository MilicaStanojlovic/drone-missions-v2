import "server-only";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mission, rating, users } from "@/db/schema";
import type { Rating } from "@/features/ratings/rating.types";

/**
 * The rating data-access layer (replaces `data.repository.RatingRepository`).
 *
 * Two slices, added in two phases:
 *
 * 1. The **aggregates** (`summariesFor`/`summaryFor`/`summaryOf`, Phase 2) —
 *    the reputation numbers every view of a user shows, ported from
 *    `RatingRepository.summariesFor` plus the `summariesFor`/`summaryFor` half
 *    of `business.service.rating.RatingService`. They live in the query module
 *    rather than a service because they are pure aggregate reads with no
 *    business rules on top: the Java `RatingService` methods add exactly two
 *    things to the repository query — dropping null ids and defaulting an
 *    absent user to `NONE` — both of which are properties of the aggregate
 *    itself, not policy. A service that only re-exported them would be a layer
 *    with nothing in it.
 *
 * 2. The **row-level reads and the one write** (`insertRating`,
 *    `existsByMissionAndRater`, `findByMissionId`, `findByRateeId`, Phase 6) —
 *    the rest of `RatingRepository`, i.e. what the ratings vertical's
 *    `rating.service.ts` (`create`/`forMission`/`receivedBy`) is built on.
 *    Unlike the aggregates these carry no policy either: the participant gate,
 *    the COMPLETED check, the already-rated conflict and the counterpart
 *    resolution all belong to the service.
 *
 * Both row reads join `mission` and `users`, because `RatingMapper` reads
 * `rating.getMission().getName()` and `rating.getRater().getUsername()` off
 * the JPA relations — its own javadoc is "the relations carry the names, so
 * the mapper reads them off the entity rather than looking each one up".
 * Materialising the two names in the same statement is what keeps that true
 * here; without the join the mapper would be an N+1 of mission/user lookups.
 *
 * No transaction handles: unlike `BidService.accept`, no method of the Java
 * `RatingService` is `@Transactional` — `create` inserts a single row and then
 * records an audit entry outside any transaction — so nothing here needs to
 * join a caller's transaction and every function runs on the pool.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/repository/RatingRepository.java
 * - drone-missions-backend/.../data/model/Rating.java
 * - drone-missions-backend/.../business/service/rating/RatingService.java
 * - drone-missions-backend/.../business/service/rating/RatingSummary.java
 * - drone-missions-backend/.../web/mapper/rating/RatingMapper.java
 * - drone-missions-backend/.../src/main/resources/db/migration/V11__create_rating_table.sql
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

// --- Row-level reads and the single write (the rest of `RatingRepository`) ---

/**
 * What `insertRating()` accepts — the counterpart of the `Rating` entity
 * `RatingService.create` builds before handing it to `ratingRepository.save`.
 *
 * Insert-only, with no `id` field, because a rating is written once and never
 * changed: the entity has no `updatedAt`, and `rating_mission_rater_unique`
 * (V11) is what makes that final. Spring Data's `save()` would happily merge a
 * rating carrying an id, but nothing in the source ever calls it that way, so
 * the port does not offer the branch.
 *
 * The three ids are the `@ManyToOne` relations' FK columns. The source sets
 * `rater`/`ratee` from `userRepository.getReferenceById(...)` precisely
 * *because* only the FK value is needed — a reference, not a loaded row — so
 * passing the raw ids here is the same statement, minus the proxy.
 *
 * It lives in this module rather than in `rating.types.ts` for the reason that
 * file documents about itself: a DAO write shape is server-side only and
 * belongs behind `import "server-only"`, the same placement precedent as
 * `BidWrite` in `bid.queries.ts`.
 */
export interface RatingWrite {
  /** The `mission` relation's FK column; `NOT NULL` (V11). */
  missionId: number;
  /** The `rater` relation's FK column; `NOT NULL` (V11). */
  raterId: number;
  /** The `ratee` relation's FK column; `NOT NULL` (V11). */
  rateeId: number;
  /** 1–5, enforced by `rating_score_check` (V11) as well as by the schema. */
  score: number;
  comment: string | null;
}

/** The row shape the joined reads below produce before narrowing. */
type JoinedRatingRow = {
  rating: typeof rating.$inferSelect;
  mission: { id: number; name: string | null };
  rater: { id: number; username: string };
};

/** Narrows a joined row into a `Rating`. No column needs converting. */
function toRating(row: JoinedRatingRow): Rating {
  return { ...row.rating, mission: row.mission, rater: row.rater };
}

/**
 * The base read: every rating column plus the two names the mapper needs.
 *
 * INNER joins: `rating.mission_id` and `rating.rater_id` are both `NOT NULL`
 * with foreign keys (V11), and the Java entity agrees
 * (`@JoinColumn(nullable = false)` on each), so neither relation can be
 * absent. Selecting only `mission.id`/`mission.name` keeps a mission's two
 * `jsonb` flight-plan columns out of every rating list, and taking only
 * `id`/`username` from `users` means no password hash is ever loaded into one.
 *
 * `ratee` is not joined: `RatingMapper` emits `rateeId` and no ratee name, so
 * a second join on `users` would load a column nothing reads.
 */
function selectRatings() {
  return getDb()
    .select({
      rating: getTableColumns(rating),
      mission: { id: mission.id, name: mission.name },
      rater: { id: users.id, username: users.username },
    })
    .from(rating)
    .innerJoin(mission, eq(rating.missionId, mission.id))
    .innerJoin(users, eq(rating.raterId, users.id));
}

/**
 * Whether this rater has already rated this mission. Mirrors
 * `existsByMission_IdAndRater_Id` — the check `RatingService.create` makes
 * before building the row, which is what turns a second attempt into
 * `AlreadyRatedException` rather than a constraint violation.
 *
 * `select … limit 1` rather than a `count(*)`: the question is existence, and
 * `rating_mission_rater_unique` means at most one row can match anyway.
 */
export async function existsByMissionAndRater(
  missionId: number,
  raterId: number,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: rating.id })
    .from(rating)
    .where(and(eq(rating.missionId, missionId), eq(rating.raterId, raterId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Both ratings on a mission, newest first. Mirrors
 * `findByMission_IdOrderByCreatedAtDesc` — at most two rows, one per side, so
 * a participant can see whether they have rated yet.
 *
 * `id DESC` is added as a tiebreaker, exactly as `bid.queries.ts` and
 * `notification.queries.ts` do: the source orders by `created_at` alone, which
 * leaves rows sharing a timestamp in an unspecified order, and since ids are
 * monotonic this keeps "newest first" true rather than arbitrary for two
 * ratings written inside the same clock tick — without reordering any pair the
 * source already ordered.
 */
export async function findByMissionId(missionId: number): Promise<Rating[]> {
  const rows = await selectRatings()
    .where(eq(rating.missionId, missionId))
    .orderBy(desc(rating.createdAt), desc(rating.id));
  return rows.map(toRating);
}

/**
 * Every rating a user has received, newest first. Mirrors
 * `findByRatee_IdOrderByCreatedAtDesc` — the profile page's list of reviews,
 * which is what `idx_rating_ratee` (V11) exists for. Same id tiebreaker as
 * above.
 *
 * No moderation filter, matching the source: a review stays on a profile even
 * if the mission it came from has since been hidden.
 */
export async function findByRateeId(rateeId: number): Promise<Rating[]> {
  const rows = await selectRatings()
    .where(eq(rating.rateeId, rateeId))
    .orderBy(desc(rating.createdAt), desc(rating.id));
  return rows.map(toRating);
}

/**
 * Persist a new rating and return it with its mission and rater resolved.
 * Mirrors `ratingRepository.save(rating)` on a fresh entity: the id is
 * identity-generated (V11), and the returned row is what
 * `RatingService.create` hands to both the audit entry (which reads the saved
 * id) and the mapper.
 *
 * `created_at` is stamped here because the column has no database default and
 * Hibernate's `@CreationTimestamp` does it on the Java side. It is
 * `updatable = false` there, and this module offers no update at all, so the
 * value a rating is born with is the only one it will ever have.
 *
 * `rating_mission_rater_unique` stands behind the insert as a backstop, not as
 * an upsert mechanism: `RatingService.create` decides with
 * `existsByMissionAndRater` first, exactly as the source does. If two
 * concurrent creates race past that check, the constraint rejects the loser
 * rather than letting a second rating through — there is no `ON CONFLICT`
 * clause because the source has no equivalent, and swallowing the race would
 * change behaviour.
 *
 * The saved row is re-read through the joins instead of being assembled from
 * the write: `returning()` yields the rating columns only, and the mapper
 * needs the mission and rater names attached.
 */
export async function insertRating(input: RatingWrite): Promise<Rating> {
  const [inserted] = await getDb()
    .insert(rating)
    .values({
      missionId: input.missionId,
      raterId: input.raterId,
      rateeId: input.rateeId,
      score: input.score,
      comment: input.comment,
      createdAt: new Date(),
    })
    .returning({ id: rating.id });

  const [saved] = await selectRatings().where(eq(rating.id, inserted.id));
  if (!saved) {
    throw new Error(`Rating ${inserted.id} vanished immediately after being saved`);
  }
  return toRating(saved);
}
