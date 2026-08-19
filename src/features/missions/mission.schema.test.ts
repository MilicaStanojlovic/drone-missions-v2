import { describe, expect, it } from "vitest";
import { geofenceSchema, missionRequestSchema, waypointSchema } from "./mission.schema";
import type { WaypointAction } from "./mission.types";

/**
 * Vitest suite for `mission.schema.ts` — DB-less coverage of the flight-plan
 * validation rules ported from `MissionRequest`, `Waypoint`, `GeoPoint` and
 * `Geofence`.
 *
 * The `waypointSchema` block mirrors `WaypointActionValidatorTest`
 * case-for-case, including its central point: the property path matters as
 * much as the failure, because `withErrorHandling` (like
 * `GlobalExceptionHandler`) reports path-carrying field errors only, so a
 * cross-field violation with no path would vanish from the 400 body.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/model/WaypointActionValidatorTest.java
 * - drone-missions-backend/.../data/model/{Waypoint,GeoPoint,Geofence}.java
 * - drone-missions-backend/.../web/dto/mission/MissionRequest.java
 */

/** Mirrors the Java test's `waypoint(...)` factory: same 45N/19E fixture point. */
function waypoint(
  altitude: number | null,
  action: WaypointAction | null,
  hoverDurationSeconds: number | null,
): Record<string, unknown> {
  return { lat: 45.0, lng: 19.0, altitude, action, hoverDurationSeconds };
}

/** Mirrors the Java test's `propertyPaths(...)`: the set of failing paths. */
function propertyPaths(value: unknown): string[] {
  const result = waypointSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

function isValid(value: unknown): boolean {
  return waypointSchema.safeParse(value).success;
}

describe("waypointSchema (ports WaypointActionValidator + Waypoint's constraints)", () => {
  it("accepts a PHOTO waypoint without a hover duration", () => {
    expect(isValid(waypoint(50.0, "PHOTO", null))).toBe(true);
  });

  it("accepts a HOVER waypoint with a positive duration", () => {
    expect(isValid(waypoint(50.0, "HOVER", 30))).toBe(true);
  });

  it("requires an altitude, mirroring @NotNull", () => {
    expect(propertyPaths(waypoint(null, "PHOTO", null))).toContain("altitude");
  });

  it("requires a positive altitude, mirroring @Positive", () => {
    expect(propertyPaths(waypoint(0.0, "PHOTO", null))).toContain("altitude");
  });

  it('caps altitude at the legal 120 m ceiling, mirroring @DecimalMax("120")', () => {
    expect(propertyPaths(waypoint(120.1, "PHOTO", null))).toContain("altitude");
    expect(isValid(waypoint(120.0, "PHOTO", null))).toBe(true);
  });

  it("requires an action, mirroring @NotNull", () => {
    expect(propertyPaths(waypoint(50.0, null, null))).toContain("action");
  });

  it("fails HOVER without a duration on the hoverDurationSeconds property", () => {
    expect(propertyPaths(waypoint(50.0, "HOVER", null))).toEqual(["hoverDurationSeconds"]);
  });

  it("fails HOVER with a non-positive duration on the hoverDurationSeconds property", () => {
    expect(propertyPaths(waypoint(50.0, "HOVER", 0))).toEqual(["hoverDurationSeconds"]);
    expect(propertyPaths(waypoint(50.0, "HOVER", -5))).toEqual(["hoverDurationSeconds"]);
  });

  it("rejects a duration on a non-HOVER action, on the hoverDurationSeconds property", () => {
    expect(propertyPaths(waypoint(50.0, "PHOTO", 10))).toEqual(["hoverDurationSeconds"]);
    expect(propertyPaths(waypoint(50.0, "START_RECORDING", 10))).toEqual(["hoverDurationSeconds"]);
  });

  it("uses the validator's exact messages", () => {
    const missingDuration = waypointSchema.safeParse(waypoint(50.0, "HOVER", null));
    expect(missingDuration.success).toBe(false);
    if (!missingDuration.success) {
      expect(missingDuration.error.issues[0].message).toBe(
        "must be greater than 0 for a HOVER waypoint",
      );
    }

    const strayDuration = waypointSchema.safeParse(waypoint(50.0, "PHOTO", 10));
    expect(strayDuration.success).toBe(false);
    if (!strayDuration.success) {
      expect(strayDuration.error.issues[0].message).toBe("is only allowed on a HOVER waypoint");
    }
  });

  it("does not double-report when the action is missing — the @NotNull violation stands alone", () => {
    // `WaypointActionValidator.isValid` returns true for a null action:
    // "a missing action is already reported by @NotNull".
    expect(propertyPaths(waypoint(50.0, null, 10))).toEqual(["action"]);
  });

  it("treats an omitted hoverDurationSeconds the same as an explicit null", () => {
    expect(
      waypointSchema.safeParse({ lat: 45, lng: 19, altitude: 50, action: "PHOTO" }).success,
    ).toBe(true);
    expect(
      waypointSchema.safeParse({ lat: 45, lng: 19, altitude: 50, action: "HOVER" }).success,
    ).toBe(false);
  });

  it("rejects a fractional hover duration — the source field is an Integer", () => {
    expect(propertyPaths(waypoint(50.0, "HOVER", 30.5))).toContain("hoverDurationSeconds");
  });

  it("rejects an unknown action value", () => {
    expect(isValid({ lat: 45, lng: 19, altitude: 50, action: "LAND" })).toBe(false);
  });

  it("enforces the GeoPoint latitude bounds inclusively, mirroring @DecimalMin/@DecimalMax", () => {
    expect(isValid({ lat: 90, lng: 19, altitude: 50, action: "PHOTO" })).toBe(true);
    expect(isValid({ lat: -90, lng: 19, altitude: 50, action: "PHOTO" })).toBe(true);
    expect(propertyPaths({ lat: 90.1, lng: 19, altitude: 50, action: "PHOTO" })).toContain("lat");
    expect(propertyPaths({ lat: -90.1, lng: 19, altitude: 50, action: "PHOTO" })).toContain("lat");
  });

  it("enforces the GeoPoint longitude bounds inclusively", () => {
    expect(isValid({ lat: 45, lng: 180, altitude: 50, action: "PHOTO" })).toBe(true);
    expect(isValid({ lat: 45, lng: -180, altitude: 50, action: "PHOTO" })).toBe(true);
    expect(propertyPaths({ lat: 45, lng: 180.1, altitude: 50, action: "PHOTO" })).toContain("lng");
    expect(propertyPaths({ lat: 45, lng: -180.1, altitude: 50, action: "PHOTO" })).toContain("lng");
  });
});

describe("geofenceSchema (ports Geofence.isConsistent)", () => {
  const center = { lat: 45, lng: 19 };
  const triangle = [
    { lat: 45, lng: 19 },
    { lat: 45.1, lng: 19 },
    { lat: 45, lng: 19.1 },
  ];

  it("accepts a CIRCLE with a center and a radius", () => {
    expect(geofenceSchema.safeParse({ type: "CIRCLE", center, radiusMeters: 500 }).success).toBe(
      true,
    );
  });

  it("rejects a CIRCLE without a center", () => {
    expect(geofenceSchema.safeParse({ type: "CIRCLE", radiusMeters: 500 }).success).toBe(false);
  });

  it("rejects a CIRCLE without a radius", () => {
    expect(geofenceSchema.safeParse({ type: "CIRCLE", center }).success).toBe(false);
  });

  it("rejects a non-positive radius, mirroring @Positive", () => {
    expect(geofenceSchema.safeParse({ type: "CIRCLE", center, radiusMeters: 0 }).success).toBe(
      false,
    );
  });

  it("accepts a POLYGON with at least 3 points", () => {
    expect(geofenceSchema.safeParse({ type: "POLYGON", points: triangle }).success).toBe(true);
  });

  it("rejects a POLYGON with fewer than 3 points", () => {
    expect(
      geofenceSchema.safeParse({ type: "POLYGON", points: triangle.slice(0, 2) }).success,
    ).toBe(false);
    expect(geofenceSchema.safeParse({ type: "POLYGON", points: [] }).success).toBe(false);
    expect(geofenceSchema.safeParse({ type: "POLYGON" }).success).toBe(false);
  });

  it("rejects a shape whose fields belong to the other type", () => {
    expect(geofenceSchema.safeParse({ type: "POLYGON", center, radiusMeters: 500 }).success).toBe(
      false,
    );
    expect(geofenceSchema.safeParse({ type: "CIRCLE", points: triangle }).success).toBe(false);
  });

  it("reports the inconsistency on the `consistent` property, where @AssertTrue puts it", () => {
    const result = geofenceSchema.safeParse({ type: "CIRCLE" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(["consistent"]);
      expect(result.error.issues[0].message).toBe(
        "a CIRCLE needs center + radiusMeters; a POLYGON needs at least 3 points",
      );
    }
  });

  it("validates the bounds of each polygon point, mirroring @Valid cascading", () => {
    const result = geofenceSchema.safeParse({
      type: "POLYGON",
      points: [...triangle.slice(0, 2), { lat: 91, lng: 19 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("points.2.lat");
    }
  });

  it("requires a type, mirroring @NotNull", () => {
    expect(geofenceSchema.safeParse({ center, radiusMeters: 500 }).success).toBe(false);
  });
});

describe("missionRequestSchema (ports MissionRequest)", () => {
  const valid = {
    name: "Roof survey",
    description: "Photograph the north roof",
    status: "PUBLISHED",
    startTime: "2026-09-01T09:00:00.000Z",
    endTime: "2026-09-01T11:00:00.000Z",
    location: "Novi Sad",
    biddingDeadline: "2026-08-30",
    waypoints: [
      { lat: 45.0, lng: 19.0, altitude: 50, action: "PHOTO" },
      { lat: 45.1, lng: 19.1, altitude: 60, action: "HOVER", hoverDurationSeconds: 30 },
    ],
    geofence: { type: "CIRCLE", center: { lat: 45, lng: 19 }, radiusMeters: 800 },
  };

  function paths(value: unknown): string[] {
    const result = missionRequestSchema.safeParse(value);
    if (result.success) return [];
    return result.error.issues.map((issue) => issue.path.join("."));
  }

  it("accepts a well-formed request", () => {
    expect(missionRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("parses the Instant fields into Dates", () => {
    const result = missionRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.startTime).toBeInstanceOf(Date);
      expect(result.data.startTime.toISOString()).toBe("2026-09-01T09:00:00.000Z");
      expect(result.data.endTime).toBeInstanceOf(Date);
    }
  });

  it("keeps biddingDeadline a bare calendar day, as LocalDate has no time or zone", () => {
    const result = missionRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.biddingDeadline).toBe("2026-08-30");
    }
  });

  it("rejects a missing name, mirroring @NotBlank", () => {
    expect(paths({ ...valid, name: "" })).toContain("name");
    const withoutName: Record<string, unknown> = { ...valid };
    delete withoutName.name;
    expect(paths(withoutName)).toContain("name");
  });

  it("rejects a whitespace-only name, mirroring @NotBlank", () => {
    expect(paths({ ...valid, name: "   " })).toContain("name");
  });

  it("rejects a description over 2000 characters, mirroring @Size(max = 2000)", () => {
    expect(paths({ ...valid, description: "x".repeat(2001) })).toContain("description");
    expect(
      missionRequestSchema.safeParse({ ...valid, description: "x".repeat(2000) }).success,
    ).toBe(true);
  });

  it("rejects a location over 255 characters, mirroring @Size(max = 255)", () => {
    expect(paths({ ...valid, location: "x".repeat(256) })).toContain("location");
    expect(missionRequestSchema.safeParse({ ...valid, location: "x".repeat(255) }).success).toBe(
      true,
    );
  });

  it("allows the nullable flight-plan fields to be omitted, as the source declares no @NotNull on them", () => {
    const minimal: Record<string, unknown> = { ...valid };
    delete minimal.description;
    delete minimal.location;
    delete minimal.biddingDeadline;
    delete minimal.geofence;
    expect(missionRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it("requires a status, mirroring @NotNull", () => {
    const withoutStatus: Record<string, unknown> = { ...valid };
    delete withoutStatus.status;
    expect(paths(withoutStatus)).toContain("status");
    expect(paths({ ...valid, status: "ARCHIVED" })).toContain("status");
  });

  it("requires startTime and endTime, mirroring @NotNull", () => {
    const withoutTimes: Record<string, unknown> = { ...valid };
    delete withoutTimes.startTime;
    delete withoutTimes.endTime;
    expect(paths(withoutTimes)).toEqual(expect.arrayContaining(["startTime", "endTime"]));
  });

  it("rejects an unparseable timestamp", () => {
    expect(paths({ ...valid, startTime: "not-a-timestamp" })).toContain("startTime");
  });

  it("rejects a missing flight path with the source's message", () => {
    const withoutWaypoints: Record<string, unknown> = { ...valid };
    delete withoutWaypoints.waypoints;
    const result = missionRequestSchema.safeParse(withoutWaypoints);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path.join(".")).toBe("waypoints");
      expect(result.error.issues[0].message).toBe("a flight path needs at least 2 waypoints");
    }
  });

  it("rejects a single dangling waypoint, mirroring @Size(min = 2)", () => {
    const result = missionRequestSchema.safeParse({ ...valid, waypoints: [valid.waypoints[0]] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("a flight path needs at least 2 waypoints");
    }
  });

  it("cascades waypoint validation and indexes the failing waypoint, mirroring @Valid", () => {
    const result = missionRequestSchema.safeParse({
      ...valid,
      waypoints: [valid.waypoints[0], { lat: 45.1, lng: 19.1, altitude: 60, action: "HOVER" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // `withErrorHandling` renders this path as `waypoints[1].hoverDurationSeconds`,
      // the bracket form the Angular mission form parses.
      expect(result.error.issues[0].path).toEqual(["waypoints", 1, "hoverDurationSeconds"]);
      expect(result.error.issues[0].message).toBe("must be greater than 0 for a HOVER waypoint");
    }
  });

  it("cascades geofence validation, mirroring @Valid", () => {
    const result = missionRequestSchema.safeParse({
      ...valid,
      geofence: { type: "POLYGON", points: [{ lat: 45, lng: 19 }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path.join(".")).toBe("geofence.consistent");
    }
  });

  it("ignores unknown properties, as Spring Boot's Jackson defaults do", () => {
    const result = missionRequestSchema.safeParse({ ...valid, moderation: "HIDDEN", id: 7 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("moderation");
      expect(result.data).not.toHaveProperty("id");
    }
  });
});
