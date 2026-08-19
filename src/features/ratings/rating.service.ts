import "server-only";
import { ratingCreated, record } from "@/lib/audit";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { getMissionDao } from "@/features/missions/mission.cache";
import { MissionNotFoundError } from "@/features/missions/mission.service";
import type { Mission, MissionStatus } from "@/features/missions/mission.types";
import * as queries from "./rating.queries";
import type { Rating } from "./rating.types";

/**
 * Rating business logic (replaces the write/participant-read half of
 * `business.service.rating.RatingService`).
 *
 * Three methods land here — `create`, `forMission`, `receivedBy`. The
 * remaining two on the Java class (`summaryFor`/`summariesFor`) hold no policy
 * at all: they are pure `GROUP BY` aggregates, and Phase 2 ported them straight
 * into `rating.queries.ts` for the reason that file documents (a service layer
 * that only forwarded them would hold nothing). `summaryFor` is re-exported
 * verbatim at the foot of this file so that the one caller outside the feature
 * — `GET /ratings/user/{id}`, which needs it beside `receivedBy` exactly as
 * `RatingController.forUser` does — names a single layer rather than reaching
 * into the query module itself. Everything *written* in this module is policy,
 * and all of it hangs off one idea:
 *
 * > The mission row is the only membership record there is, so it answers both
 * > "may this person rate?" and "who are they rating?" at once.
 *
 * That is the source's own javadoc, and it is why `create` never takes a ratee
 * id from the caller: the counterpart is *derived* from the mission
 * (`counterpartOf`), so nobody can rate a stranger by guessing a user id, and
 * the same lookup that authorises the rating also addresses it.
 *
 * ## Ratings are final
 * There is no update and no delete, here or in the query layer:
 * `rating_mission_rater_unique` (V11) plus the `existsByMissionAndRater` check
 * below make a rating a once-only, permanent record. That is what
 * `AlreadyRatedError` protects — not a race, but the rule itself.
 *
 * ## No transaction
 * Unlike `BidService.accept`, no method of the Java `RatingService` is
 * `@Transactional`: `create` writes exactly one row and then records an audit
 * entry after it, so there is nothing to make atomic. This port keeps that
 * shape — a single insert on the pool, then `record(...)`.
 *
 * ## Cached mission reads
 * Both `create` and `forMission` load the mission through the cached
 * `findById`, never `findFresh`, exactly as the source does and for the reason
 * its comment gives: "rating never writes the mission, so a cached copy is
 * fine". Nothing here ever hands a mission back to `save()`, so the
 * read-only/write split `bid.service.ts` documents is satisfied by using the
 * cached side throughout.
 *
 * ## No visibility filter
 * `create` and `forMission` require only that the mission *exists* — the source
 * applies neither the moderation check nor `MissionService.isVisibleTo` here.
 * A participant can therefore still rate, and still read the ratings on, a
 * mission an admin has since hidden: they took part in it, and hiding it from
 * the marketplace does not retract that.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/rating/RatingService.java
 * - drone-missions-backend/.../business/exception/rating/{AlreadyRatedException,NotMissionParticipantException,RatingNotYetAllowedException}.java
 * - drone-missions-backend/.../business/service/audit/NewAuditEntry.java (`ratingCreated`)
 * - test drone-missions-backend/.../business/service/rating/RatingServiceTest.java
 */

/**
 * Thrown when a mission has not reached COMPLETED, so there is nothing to rate
 * yet. Mirrors `RatingNotYetAllowedException`; the base (`ConflictError`) maps
 * to 409.
 *
 * The refused status is named in the message, exactly as in the source — the
 * Angular client surfaces the text verbatim in its error toast, and "it can
 * only be rated once completed" is only actionable if the reader is told where
 * the mission actually is.
 */
export class RatingNotYetAllowedError extends ConflictError {
  constructor(missionId: number, status: MissionStatus) {
    super(`Mission ${missionId} is ${status} — it can only be rated once completed`);
  }
}

/**
 * Thrown on a second rating from the same person for the same mission. Mirrors
 * `AlreadyRatedException`; the base (`ConflictError`) maps to 409.
 */
export class AlreadyRatedError extends ConflictError {
  constructor(missionId: number) {
    super(`You have already rated mission ${missionId}`);
  }
}

/**
 * Thrown when someone who was neither the designer nor the awarded pilot tries
 * to rate a mission, or to read its ratings. Mirrors
 * `NotMissionParticipantException`; the base (`ForbiddenError`) maps to 403.
 *
 * A 403 rather than the 404-masking `bid.service.ts` uses for missions: the
 * caller already had to name a mission id that exists, and unlike the bid
 * flows there is nothing here to keep secret from them — the source makes the
 * same choice.
 */
export class NotMissionParticipantError extends ForbiddenError {
  constructor(missionId: number) {
    super(`You did not take part in mission ${missionId}, so you cannot rate it`);
  }
}

/**
 * Write the caller's rating of their counterpart on a completed mission.
 * Mirrors `RatingService.create`.
 *
 * The guard order is the source's, and it is observable: existence -> status
 * -> already-rated -> participation. A non-participant poking at an
 * in-progress mission therefore learns its status (409) before being told they
 * were not part of it (403) — which is harmless, since mission status is
 * public on the feed anyway, and reversing it would change the status code the
 * Angular client keys its toast off.
 *
 * The ratee is never supplied by the caller; it is derived from the mission by
 * `counterpartOf`, which doubles as the participation check.
 *
 * The audit entry is recorded last, from the *saved* row — it needs the
 * identity id the insert assigns — so a rejected rating audits nothing.
 *
 * @throws MissionNotFoundError if no such mission exists
 * @throws RatingNotYetAllowedError if the mission has not reached COMPLETED
 * @throws AlreadyRatedError if this rater has already rated this mission
 * @throws NotMissionParticipantError if the rater is neither the designer nor
 * the awarded pilot (including a designer whose mission was never awarded)
 */
export async function create(
  missionId: number,
  raterId: number,
  score: number,
  comment: string | null | undefined,
): Promise<Rating> {
  // Read-only: rating never writes the mission, so a cached copy is fine.
  const mission = await getMissionOrThrow(missionId);

  if (mission.status !== "COMPLETED") {
    throw new RatingNotYetAllowedError(missionId, mission.status);
  }
  if (await queries.existsByMissionAndRater(missionId, raterId)) {
    throw new AlreadyRatedError(missionId);
  }

  // Resolved before the insert, exactly as the source builds the entity: this
  // is both "who is being rated" and the participation gate.
  const rateeId = counterpartOf(mission, raterId);
  const saved = await queries.insertRating({
    missionId,
    raterId,
    rateeId,
    score,
    comment: comment ?? null,
  });
  await record(ratingCreated(raterId, mission, saved));
  return saved;
}

/**
 * Both ratings for a mission, newest first, so a participant can see whether
 * they have rated yet — and read the one they were given. Mirrors
 * `RatingService.forMission`.
 *
 * Participant-gated rather than public: the pair of ratings on a mission is a
 * private exchange between its two sides. At most two rows come back (one per
 * side, by `rating_mission_rater_unique`).
 *
 * @throws MissionNotFoundError if no such mission exists
 * @throws NotMissionParticipantError if the caller took no part in it
 */
export async function forMission(missionId: number, callerId: number): Promise<Rating[]> {
  const mission = await getMissionOrThrow(missionId);
  requireParticipant(mission, callerId);
  return queries.findByMissionId(missionId);
}

/**
 * Every rating a user has received, newest first — the reviews half of a
 * profile. Mirrors `RatingService.receivedBy`.
 *
 * Ungated on purpose (the source gates nothing here either): a reputation is
 * public, which is the whole point of showing it next to a bid. Note the
 * asymmetry with `forMission` — *who rated whom on which mission* is private
 * to that mission's two participants, while *what a user has been rated* is
 * not.
 */
export async function receivedBy(userId: number): Promise<Rating[]> {
  return queries.findByRateeId(userId);
}

/**
 * The other side of the mission from the rater's point of view — the designer
 * rates the awarded pilot, the awarded pilot rates the designer. Mirrors
 * `RatingService.counterpartOf`, including its double duty as the
 * participation check: anyone who is neither side has no counterpart, and that
 * is precisely the condition for refusing the rating.
 *
 * The designer branch requires an awarded pilot to exist, as in the source: a
 * mission that was completed without ever being awarded (only reachable
 * through direct data manipulation) leaves the designer with nobody to rate,
 * and that is a 403 rather than a null ratee.
 *
 * KNOWN DIVERGENCE (unreachable in practice, and in the safer direction): the
 * pilot branch is guarded symmetrically, so an awarded pilot on an *ownerless*
 * mission (`user_id` null — a legacy pre-auth row) also gets
 * `NotMissionParticipantError`. The source returns the null designer id
 * straight into `userRepository.getReferenceById(null)`, which throws an
 * unmapped NPE and surfaces as a 500. Both refuse the rating; this one refuses
 * it as the 403 the situation actually is. Nothing in the app can award a
 * mission that has no designer, so no supported flow reaches either branch.
 */
function counterpartOf(mission: Mission, raterId: number): number {
  if (raterId === mission.userId && mission.awardedPilotId !== null) {
    return mission.awardedPilotId;
  }
  if (raterId === mission.awardedPilotId && mission.userId !== null) {
    return mission.userId;
  }
  throw new NotMissionParticipantError(mission.id);
}

/**
 * The read-side gate: only the mission's two sides may see its ratings.
 * Mirrors `RatingService.requireParticipant`.
 *
 * Unlike `counterpartOf` this needs no non-null counterpart — it asks only
 * whether the caller is one of the two ids, and `callerId` is always a real
 * authenticated id, so a null column simply fails to match.
 */
function requireParticipant(mission: Mission, callerId: number): void {
  if (callerId !== mission.userId && callerId !== mission.awardedPilotId) {
    throw new NotMissionParticipantError(mission.id);
  }
}

/**
 * Read-only mission lookup — may be served from cache, so the result is never
 * handed to `save()`. The port of
 * `missionDao.findById(id).orElseThrow(() -> new MissionNotFoundException(id))`,
 * mirroring the identical helper in `bid.service.ts`.
 */
async function getMissionOrThrow(missionId: number): Promise<Mission> {
  const mission = await getMissionDao().findById(missionId);
  if (mission === undefined) {
    throw new MissionNotFoundError(missionId);
  }
  return mission;
}

/**
 * One user's average and count, as `RatingService.summaryFor` exposes it.
 *
 * A pass-through, not a wrapper: the aggregate itself lives in
 * `rating.queries.ts` (Phase 2 put it there so `mission.mapper.ts` could stamp a
 * designer's rating onto every mission), and there is no policy to add — the
 * Java method has none either. It is surfaced here purely so a route handler
 * asking for a user's reputation talks to the service layer only, per the
 * target's "handlers never touch the DB" rule. In-feature callers keep using
 * `rating.queries.ts` directly.
 */
export { summaryFor } from "./rating.queries";
