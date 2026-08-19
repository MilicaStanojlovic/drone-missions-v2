import "server-only";
import {
  summariesFor,
  summaryFor,
  summaryOf,
  type RatingSummary,
} from "@/features/ratings/rating.queries";
import type { GeofenceInput, MissionRequestInput } from "./mission.schema";
import type { MissionDraft } from "./mission.service";
import type {
  Geofence,
  Mission,
  MissionModeration,
  MissionStatus,
  Waypoint,
} from "./mission.types";

/**
 * Mission DTO mapping (replaces `web.mapper.mission.MissionMapper` and the
 * private `toResponses`/`toResponse`/`ratingOf` helpers on
 * `MissionController` that feed it the designer's reputation).
 *
 * Both directions live here, mirroring the Java mapper: `toMissionDraft`
 * ports `toEntity` (validated request -> the shape the service persists) and
 * `toMissionResponse` ports `toResponse`.
 *
 * The controller's batching helpers live here rather than in the route
 * handlers on purpose: in this stack a handler is a thin parse -> service ->
 * shape function, and "shape" is exactly this module. Keeping the
 * one-aggregate-query-per-page rule next to the mapper it feeds is also what
 * stops a future list endpoint from quietly reintroducing a rating lookup per
 * card.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/mapper/mission/MissionMapper.java (`toEntity`, `toResponse`)
 * - drone-missions-backend/.../web/dto/mission/{MissionRequest,MissionResponse}.java
 * - drone-missions-backend/.../web/controller/mission/MissionController.java (`toResponses`, `toResponse`, `ratingOf`)
 */

/**
 * Shapes a validated mission request into the draft the service persists.
 * Ports `MissionMapper.toEntity`: the same nine fields, and nothing else —
 * ownership, moderation and the awarded pilot are never client-supplied (the
 * Java mapper leaves them at the fresh entity's defaults; `MissionService`
 * sets ownership).
 *
 * Absent optional properties become `null` rather than `undefined`, mirroring
 * the null components Jackson leaves on the Java record for absent JSON
 * properties — the columns they map to are nullable, and `save()` writes
 * exactly what it is handed.
 */
export function toMissionDraft(request: MissionRequestInput): MissionDraft {
  return {
    name: request.name,
    description: request.description ?? null,
    status: request.status,
    startTime: request.startTime,
    endTime: request.endTime,
    location: request.location ?? null,
    biddingDeadline: request.biddingDeadline ?? null,
    waypoints: request.waypoints,
    geofence: toGeofence(request.geofence),
  };
}

/**
 * Narrows the validated geofence into the domain union.
 *
 * The Java mapper passes `request.geofence()` straight through, because there
 * the request DTO and the persisted value are the same flat record with four
 * nullable fields. This port models the two legal shapes as a discriminated
 * union instead (see `mission.types.ts`), so the flat parsed request has to be
 * narrowed into it here — the narrowing is this port's, not a rule of its own.
 *
 * The final `throw` is unreachable by construction: `geofenceSchema`'s
 * consistency rule (which ports `Geofence.isConsistent`) has already rejected
 * a CIRCLE without center/radius and a POLYGON with fewer than 3 points, so a
 * request that reaches here always matches one branch. It exists so that
 * relaxing that rule fails loudly here rather than silently writing a
 * half-built geofence into the `jsonb` column.
 */
function toGeofence(input: GeofenceInput | null | undefined): Geofence | null {
  if (input === null || input === undefined) {
    return null;
  }
  if (input.type === "CIRCLE") {
    const { center, radiusMeters } = input;
    if (center != null && radiusMeters != null) {
      return { type: "CIRCLE", center, radiusMeters };
    }
  } else {
    const { points } = input;
    if (points != null && points.length >= 3) {
      return { type: "POLYGON", points };
    }
  }
  throw new Error(
    "geofence passed missionRequestSchema but matches neither legal shape — " +
      "geofenceSchema's consistency rule and toGeofence() have drifted apart",
  );
}

/**
 * The public shape of one mission. Mirrors the `MissionResponse` record
 * field for field, including its two naming quirks, which are kept because
 * the Angular client reads these exact keys:
 *
 * - `userId` is the *designer's* id (the record names the field after the
 *   `user_id` column, not after the `designer` relation it reads it from).
 * - The three `designer*` fields are flattened off the joined account rather
 *   than nested, and are null for a legacy ownerless mission.
 *
 * `Instant` becomes `Date` (serialized to an ISO-8601 string by the route's
 * JSON response, exactly as Jackson renders an `Instant`), while
 * `biddingDeadline` stays a `yyyy-MM-dd` string — it is a `LocalDate`, a
 * calendar day with no time or zone, and turning it into a `Date` would drag
 * one in and shift the day across the boundary.
 */
export interface MissionResponse {
  id: number;
  name: string | null;
  description: string | null;
  status: MissionStatus;
  moderation: MissionModeration;
  /** The owning designer's id — nullable for legacy pre-auth missions. */
  userId: number | null;
  designerEmail: string | null;
  designerName: string | null;
  designerSuspended: boolean;
  designerRating: number;
  designerRatingCount: number;
  awardedPilotId: number | null;
  startTime: Date | null;
  endTime: Date | null;
  location: string | null;
  /** A calendar date (`yyyy-MM-dd`), not an instant — mirrors `LocalDate`. */
  biddingDeadline: string | null;
  waypoints: Waypoint[] | null;
  geofence: Geofence | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shapes one mission into its response DTO. Mirrors
 * `MissionMapper.toResponse` exactly, designer rating included: the caller
 * supplies the summary rather than the mapper fetching it, so a list of
 * missions costs one aggregate query instead of one per row.
 *
 * Every field is named explicitly rather than spread from the row, matching
 * `toUserResponse`'s reasoning in the users feature: the mission row itself
 * carries nothing secret today, but a whitelist cannot start leaking a column
 * that a later migration adds.
 */
export function toMissionResponse(
  mission: Mission,
  designerRating: RatingSummary,
): MissionResponse {
  const designer = mission.designer;
  return {
    id: mission.id,
    name: mission.name,
    description: mission.description,
    status: mission.status,
    moderation: mission.moderation,
    // The Java record reads `mission.getDesignerId()`, which is the id off
    // the `designer` relation; this column is that same value.
    userId: mission.userId,
    designerEmail: designer === null ? null : designer.email,
    // `designerName` is the account's *username* — the source maps
    // `designer.getUsername()` here, and the Angular cards render it as the
    // designer's display name.
    designerName: designer === null ? null : designer.username,
    // Not null-propagated: an ownerless mission reports `false`, not null,
    // mirroring the `designer != null && designer.isSuspended()` expression
    // over a primitive `boolean` field.
    designerSuspended: designer !== null && designer.suspended,
    designerRating: designerRating.average,
    designerRatingCount: designerRating.count,
    awardedPilotId: mission.awardedPilotId,
    startTime: mission.startTime,
    endTime: mission.endTime,
    location: mission.location,
    biddingDeadline: mission.biddingDeadline,
    waypoints: mission.waypoints,
    geofence: mission.geofence,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

/**
 * Shapes a whole list of missions, fetching every designer's reputation in
 * one aggregate query. Ports `MissionController.toResponses`.
 *
 * Ownerless (null-designer) missions are safe here in both directions: their
 * ids are dropped before the query runs, and `summaryOf` answers `NONE` for
 * them without a map lookup — the case the source's `MissionControllerTest`
 * pins, where a page of only such missions must still render.
 */
export async function loadMissionResponses(missions: Mission[]): Promise<MissionResponse[]> {
  const ratings = await summariesFor(missions.map((m) => m.userId));
  return missions.map((m) => toMissionResponse(m, summaryOf(ratings, m.userId)));
}

/**
 * Shapes a single mission, looking up its designer's reputation. Ports the
 * one-argument `MissionController.toResponse`.
 */
export async function loadMissionResponse(mission: Mission): Promise<MissionResponse> {
  return toMissionResponse(mission, await summaryFor(mission.userId));
}
