import "server-only";
import { z } from "zod";
import { MISSION_STATUSES } from "@/db/schema";
import { GEOFENCE_TYPES, WAYPOINT_ACTIONS } from "./mission.types";

/**
 * Mission request validation — replaces the Jakarta Bean Validation
 * annotations on `MissionRequest`, on the `Waypoint`/`GeoPoint`/`Geofence`
 * records it cascades into (`@Valid`), and the two custom cross-field rules:
 * the class-level `@ValidWaypointAction` (`WaypointActionValidator`) and
 * `Geofence`'s `@AssertTrue isConsistent()`.
 *
 * Messages are the source's messages verbatim where it declares one, and
 * Hibernate Validator's default interpolated message where it does not
 * (`@NotNull` -> "must not be null", `@NotBlank` -> "must not be blank",
 * `@Size(max = n)` -> "size must be between 0 and n", `@Positive` ->
 * "must be greater than 0", `@DecimalMin`/`@DecimalMax` -> "must be
 * greater/less than or equal to X"), so the `data` map in the 400 body is
 * byte-identical to Spring's for the same payload — the Angular mission form
 * renders those strings directly.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/dto/mission/MissionRequest.java
 * - drone-missions-backend/.../data/model/Waypoint.java
 * - drone-missions-backend/.../data/model/GeoPoint.java
 * - drone-missions-backend/.../data/model/Geofence.java
 * - drone-missions-backend/.../data/model/WaypointActionValidator.java
 */

/** `@NotNull`'s default message, used wherever the source declares none. */
const REQUIRED = "must not be null";

/**
 * `Instant` field. Jackson deserializes an Instant from an ISO-8601 string,
 * so the wire type is a string and the parsed type is a `Date` (the closest
 * TS equivalent of an instant on the timeline) — the Angular form sends
 * `new Date(...).toISOString()`. An unparseable string is a Jackson
 * deserialization failure in the source (`HttpMessageNotReadableException`
 * -> 400 "Malformed or unreadable request body"); here it surfaces as a
 * field error on the same 400 instead, which is a strictly better-located
 * message for the same rejection.
 */
function instant() {
  return z
    .string({ error: REQUIRED })
    .refine((value) => !Number.isNaN(Date.parse(value)), "must be a valid ISO-8601 timestamp")
    .transform((value) => new Date(value));
}

/** The `yyyy-MM-dd` shape Jackson requires of a `LocalDate` property. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a `yyyy-MM-dd` string names a day that actually exists, the way
 * `LocalDate.parse` does — it throws on `2026-02-31` rather than rolling the
 * value forward.
 *
 * The round-trip is the check: JavaScript's own date parsing does *not*
 * validate the calendar (`new Date("2026-02-31")` silently becomes March 3),
 * so a value that survives parsing is only valid if it renders back as the
 * exact string that went in.
 */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Mirrors `GeoPoint`: `@DecimalMin`/`@DecimalMax` bounds on both degrees,
 * inclusive on each end (Bean Validation's `inclusive` defaults to `true`).
 *
 * DIVERGENCE (deliberate): `lat`/`lng` are primitive `double`s in the record,
 * so Jackson silently substitutes `0.0` when the property is absent and the
 * bounds then pass — an omitted coordinate becomes a point off the coast of
 * Africa rather than a validation error. That is an artifact of Java
 * primitives, not an intended rule, and no source test covers it, so a
 * missing coordinate is rejected here instead of being defaulted.
 */
const geoPointSchema = z.object({
  lat: z
    .number({ error: REQUIRED })
    .min(-90, "must be greater than or equal to -90")
    .max(90, "must be less than or equal to 90"),
  lng: z
    .number({ error: REQUIRED })
    .min(-180, "must be greater than or equal to -180")
    .max(180, "must be less than or equal to 180"),
});

/**
 * Mirrors `Waypoint` — the `GeoPoint` bounds, `@NotNull @Positive
 * @DecimalMax("120") Double altitude` (120 m is the legal ceiling),
 * `@NotNull WaypointAction action` — plus the class-level
 * `@ValidWaypointAction` rule ported in the `.superRefine()` below.
 *
 * `hoverDurationSeconds` is an `Integer` in the source, so a fractional
 * number is a deserialization failure there; `z.int()` rejects it as a field
 * error on the same 400.
 */
export const waypointSchema = z
  .object({
    ...geoPointSchema.shape,
    altitude: z
      .number({ error: REQUIRED })
      .gt(0, "must be greater than 0")
      .max(120, "must be less than or equal to 120"),
    action: z.enum(WAYPOINT_ACTIONS, { error: REQUIRED }),
    hoverDurationSeconds: z.int().nullish(),
  })
  /**
   * `WaypointActionValidator`: HOVER requires a positive
   * `hoverDurationSeconds`; every other action requires none. Both messages
   * are the validator's own, and both are attached to the
   * `hoverDurationSeconds` path exactly as the validator's
   * `addPropertyNode(PROPERTY)` does — `withErrorHandling` reports only
   * path-carrying issues as field errors, the same way
   * `GlobalExceptionHandler` builds its response from `getFieldErrors()`
   * alone, so a pathless class-level violation would vanish from the body.
   */
  .superRefine((waypoint, ctx) => {
    // "a missing action is already reported by @NotNull" — the validator
    // returns valid in that case rather than double-reporting. (Zod skips
    // object-level checks when a field failed to parse, so this guard is
    // belt-and-braces; it also covers an explicit null.)
    if (waypoint.action == null) return;

    const hoverDurationSeconds = waypoint.hoverDurationSeconds;
    if (waypoint.action === "HOVER") {
      if (hoverDurationSeconds == null || hoverDurationSeconds <= 0) {
        ctx.addIssue({
          code: "custom",
          message: "must be greater than 0 for a HOVER waypoint",
          path: ["hoverDurationSeconds"],
        });
      }
      return;
    }
    if (hoverDurationSeconds != null) {
      ctx.addIssue({
        code: "custom",
        message: "is only allowed on a HOVER waypoint",
        path: ["hoverDurationSeconds"],
      });
    }
  });

export type WaypointInput = z.infer<typeof waypointSchema>;

/**
 * Mirrors `Geofence`: `@NotNull type`, `@Valid center`, `@Positive
 * radiusMeters`, `@Valid List<GeoPoint> points`, plus the `@AssertTrue
 * isConsistent()` cross-field rule.
 *
 * The consistency issue is attached to the `consistent` path because that is
 * where Bean Validation puts an `@AssertTrue` on a getter — the property
 * derived from `isConsistent()` — so the field error reaching the client is
 * `geofence.consistent`, exactly as in the source.
 *
 * DIVERGENCE (framework, accept/reject unaffected): when `type` itself is
 * missing, Hibernate Validator still runs `isConsistent()` and reports both
 * `geofence.type` and `geofence.consistent`; Zod skips object-level checks
 * once a field has failed, so only `geofence.type` is reported. Same 400,
 * one fewer redundant message.
 */
export const geofenceSchema = z
  .object({
    type: z.enum(GEOFENCE_TYPES, { error: REQUIRED }),
    center: geoPointSchema.nullish(),
    radiusMeters: z.number().positive("must be greater than 0").nullish(),
    points: z.array(geoPointSchema).nullish(),
  })
  .superRefine((geofence, ctx) => {
    const consistent =
      geofence.type === "CIRCLE"
        ? geofence.center != null && geofence.radiusMeters != null
        : geofence.points != null && geofence.points.length >= 3;
    if (!consistent) {
      ctx.addIssue({
        code: "custom",
        message: "a CIRCLE needs center + radiusMeters; a POLYGON needs at least 3 points",
        path: ["consistent"],
      });
    }
  });

export type GeofenceInput = z.infer<typeof geofenceSchema>;

/**
 * Mirrors `MissionRequest` field for field.
 *
 * `biddingDeadline` is a `LocalDate` — a calendar day with no time or zone —
 * which Jackson reads from a `yyyy-MM-dd` string and which the
 * `mission.bidding_deadline` column stores as a bare `DATE`. It therefore
 * stays a string here rather than becoming a `Date` (which would drag a
 * timezone into a value that has none, shifting the day across the boundary).
 */
export const missionRequestSchema = z.object({
  // `@NotBlank` checks without mutating: the source stores the submitted
  // name verbatim, so this rejects a blank value rather than trimming it.
  name: z
    .string({ error: "must not be blank" })
    .refine((value) => value.trim().length > 0, "must not be blank"),
  description: z.string().max(2000, "size must be between 0 and 2000").nullish(),
  status: z.enum(MISSION_STATUSES, { error: REQUIRED }),
  startTime: instant(),
  endTime: instant(),
  // ---- flight plan ----
  location: z.string().max(255, "size must be between 0 and 255").nullish(),
  biddingDeadline: z
    .string()
    .regex(ISO_DATE, "must be a date in yyyy-MM-dd format")
    .refine(isCalendarDate, "must be a valid date")
    .nullish(),
  // A flight path needs a start and an end — reject a missing path or a
  // single dangling point. Both the `@NotNull` and the `@Size(min = 2)` in
  // the source carry this same message.
  waypoints: z
    .array(waypointSchema, { error: "a flight path needs at least 2 waypoints" })
    .min(2, "a flight path needs at least 2 waypoints"),
  geofence: geofenceSchema.nullish(),
});

export type MissionRequestInput = z.infer<typeof missionRequestSchema>;

/**
 * The open-feed filters, as they arrive on the query string of
 * `GET /api/v1/missions`. Ports the three `@RequestParam(required = false)`
 * arguments of `MissionController.findAll` — including the
 * `@DateTimeFormat(iso = DateTimeFormat.ISO.DATE)` on `date`, which is what
 * makes an unparseable value a 400 rather than reaching the service.
 *
 * All three are optional, and `location`/`keyword` are deliberately *not*
 * normalised here: trimming/lowercasing/blank -> null is `MissionService`'s
 * job (it is what unifies list-cache keys), and doing it twice would put the
 * same policy in two places.
 *
 * An empty value (`?date=`) counts as absent, mirroring Spring's
 * `WebDataBinder`, which converts an empty string to null for any non-String
 * target type. A `?location=` stays the empty string, exactly as it does in
 * the source, and the service's `normalize()` turns it into "no filter".
 *
 * DIVERGENCE (envelope only, same 400): Spring answers a malformed `date`
 * with `MethodArgumentTypeMismatchException` -> `{data: null, message:
 * "Invalid value for parameter 'date'"}`, whereas this schema makes it a
 * `ZodError` -> `{data: {date: "..."}, message: "Data validation failed"}` —
 * the shape `withErrorHandling()` already documents for bad query params (a
 * strictly better-located message for the same rejection).
 */
export const openMissionQuerySchema = z.object({
  location: z.string().nullish(),
  keyword: z.string().nullish(),
  date: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? null : value),
    z
      .string()
      .regex(ISO_DATE, "must be a date in yyyy-MM-dd format")
      // A day that does not exist (e.g. 2026-02-31) is rejected here exactly
      // as `LocalDate` rejects it in the source — see `isCalendarDate`.
      .refine(isCalendarDate, "must be a valid date")
      .nullish(),
  ),
});

export type OpenMissionQueryInput = z.infer<typeof openMissionQuerySchema>;
