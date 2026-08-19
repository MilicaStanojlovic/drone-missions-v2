import "server-only";
import type { MissionModeration, MissionStatus, mission } from "@/db/schema";
import { MISSION_MODERATIONS, MISSION_STATUSES } from "@/db/schema";
import type { User } from "@/features/users/user.types";

/**
 * Mission domain types — the flight-plan value objects a mission carries in
 * its two `jsonb` columns, plus the mission enums.
 *
 * None of these are database tables: `Waypoint`, `GeoPoint` and `Geofence`
 * are Java records serialized into `mission.waypoints` / `mission.geofence`
 * (see the `@JdbcTypeCode(SqlTypes.JSON)` columns on `Mission.java`), so they
 * live here as plain TypeScript shapes rather than in `src/db/schema.ts`,
 * whose `jsonb()` columns stay untyped at the Drizzle level exactly as the
 * migrations declare them.
 *
 * `MissionStatus` / `MissionModeration` are re-exported from `src/db/schema.ts`
 * rather than redeclared: those two are CHECK-constrained columns, so the
 * migration-mirrored unions there are the single definition, and the Java
 * enums (`MissionStatus.java`, `MissionModeration.java`) agree with them
 * value-for-value. Re-exporting lets mission code import every mission type
 * from one module without the union drifting into two copies.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/model/Waypoint.java
 * - drone-missions-backend/.../data/model/GeoPoint.java
 * - drone-missions-backend/.../data/model/Geofence.java
 * - drone-missions-backend/.../data/model/GeofenceType.java
 * - drone-missions-backend/.../data/model/WaypointAction.java
 * - drone-missions-backend/.../data/model/MissionStatus.java
 * - drone-missions-backend/.../data/model/MissionModeration.java
 */

export type { MissionModeration, MissionStatus };
export { MISSION_MODERATIONS, MISSION_STATUSES };

/**
 * What the drone does once it reaches a waypoint. Mirrors `WaypointAction`.
 * Only `HOVER` may carry a `hoverDurationSeconds` — see `missionRequestSchema`
 * in `mission.schema.ts`, which ports `WaypointActionValidator`.
 */
export type WaypointAction = "PHOTO" | "START_RECORDING" | "STOP_RECORDING" | "HOVER";
export const WAYPOINT_ACTIONS: WaypointAction[] = [
  "PHOTO",
  "START_RECORDING",
  "STOP_RECORDING",
  "HOVER",
];

/** The shape of a mission's flight zone. Mirrors `GeofenceType`. */
export type GeofenceType = "CIRCLE" | "POLYGON";
export const GEOFENCE_TYPES: GeofenceType[] = ["CIRCLE", "POLYGON"];

/**
 * A geographic point in WGS84 degrees. Mirrors the `GeoPoint` record; the
 * `[-90, 90]` / `[-180, 180]` bounds are request-time validation only (see
 * `mission.schema.ts`), never a property of the stored JSON.
 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * One stop on a mission's flight plan. Mirrors the `Waypoint` record.
 *
 * `altitude`, `action` and `hoverDurationSeconds` are optional here for the
 * same reason the Java record types them as nullable boxed values: waypoints
 * persisted before those fields existed still have to deserialize out of the
 * `jsonb` column. Their required-ness is enforced on *requests* only, by
 * `missionRequestSchema` — the parsed request type (`WaypointInput`) has
 * `altitude` and `action` non-optional.
 */
export interface Waypoint extends GeoPoint {
  /** Metres above ground level; the legal ceiling is 120 m. */
  altitude?: number | null;
  action?: WaypointAction | null;
  /** Seconds to hold position — only meaningful for a `HOVER` action. */
  hoverDurationSeconds?: number | null;
}

/**
 * A mission's permitted flight area. Mirrors the `Geofence` record: exactly
 * one shape, either a `CIRCLE` (`center` + `radiusMeters`) or a `POLYGON`
 * (an ordered ring of at least 3 `points`).
 *
 * The Java record is one flat shape with all four fields nullable plus an
 * `@AssertTrue isConsistent()` cross-field rule, and it serializes with
 * `@JsonInclude(NON_NULL)` so the unused fields vanish from the JSON. This
 * union expresses the same two legal JSON shapes in the type system, which
 * is what the stored column actually holds; the runtime check that a request
 * matches its declared `type` is ported in `mission.schema.ts`.
 */
export type Geofence =
  | { type: "CIRCLE"; center: GeoPoint; radiusMeters: number }
  | { type: "POLYGON"; points: GeoPoint[] };

// --- Persistence shapes (mirror `data.model.Mission`) ---

/**
 * The raw `mission` row exactly as Drizzle selects it. `waypoints` and
 * `geofence` are `unknown` here because the migrations declare them as bare
 * `jsonb` and `src/db/schema.ts` mirrors the migrations verbatim (no
 * `$type<...>()` on those two columns, so a `drizzle-kit pull` regeneration
 * cannot silently drop the narrowing). `Mission` below is the narrowed shape
 * every consumer actually uses.
 */
export type MissionRow = typeof mission.$inferSelect;

/**
 * One mission as the query layer hands it out — the row with its two `jsonb`
 * columns narrowed, plus the designer account resolved.
 *
 * `designer` mirrors the Java entity's `@ManyToOne User designer` relation,
 * which the mission mapper reads for `designerEmail`/`designerName`/
 * `designerSuspended` and the open-feed query filters on (`suspended`). It is
 * nullable for the same reason the Java field is: missions created before
 * authentication existed have a null `user_id`, and those legacy ownerless
 * rows must keep rendering.
 *
 * The `awardedPilot` relation is deliberately *not* resolved to a `User` —
 * every consumer in this phase needs only `awardedPilotId` (the mapper
 * exposes the id; the visibility rule compares it), exactly what the column
 * already carries. The lifecycle flows that dereference the pilot account
 * arrive in Phase 5.
 */
export interface Mission extends Omit<MissionRow, "waypoints" | "geofence"> {
  waypoints: Waypoint[] | null;
  geofence: Geofence | null;
  designer: User | null;
}

/**
 * What `mission.queries.ts`'s `save()` accepts — the counterpart of handing a
 * `Mission` entity to Spring Data's `save()`, which persists a new row when
 * the id is absent and merges every field when it is present.
 *
 * A loaded `Mission` is assignable to this type as-is, so the service's
 * "load via `findFresh`, mutate, save" flow ports over unchanged. A brand-new
 * mission omits `id` (identity-generated) and the timestamps (stamped by
 * `save()`, mirroring `@CreationTimestamp`/`@UpdateTimestamp`).
 *
 * `moderation` is optional and defaults to `VISIBLE`, mirroring the Java
 * field initializer `= MissionModeration.VISIBLE` on a freshly constructed
 * entity (and the column's own `DEFAULT 'VISIBLE'` from V13).
 */
export interface MissionWrite {
  id?: number | null;
  name: string | null;
  description: string | null;
  status: MissionStatus;
  moderation?: MissionModeration | null;
  /** The owning designer's id — the `designer` relation's FK column. */
  userId: number | null;
  awardedPilotId: number | null;
  startTime: Date | null;
  endTime: Date | null;
  location: string | null;
  /** A calendar date (`YYYY-MM-DD`), not an instant — mirrors `LocalDate`. */
  biddingDeadline: string | null;
  waypoints: Waypoint[] | null;
  geofence: Geofence | null;
}
