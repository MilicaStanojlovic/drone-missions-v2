import type { GeoPoint, Geofence } from "@/features/missions/mission.types";

/**
 * Geographic helpers for flight plans — real lat/lng math (haversine), with no
 * Leaflet dependency so they stay testable and can be shared by the map, the
 * mission form and any read-only render. Distances are metres.
 *
 * Ports `<frontend>/src/app/util/geo.ts` function for function. Nothing here
 * is server code: it is imported by client components, so the module carries
 * no `import "server-only"` and its only import is a **type-only** one from
 * `mission.types.ts` (erased at compile time, so the server-only marker in
 * that module is never pulled into a client bundle — the same technique
 * `features/auth/auth.client.ts` uses for `UserRole`).
 *
 * The Angular original names its point type `LatLng`; here the same shape is
 * already the domain's `GeoPoint` (mirroring the backend record), so this uses
 * `GeoPoint` throughout rather than introducing a second identical alias.
 *
 * SOURCE: drone-missions-frontend/.../src/app/util/geo.ts
 */

type CircleZone = Extract<Geofence, { type: "CIRCLE" }>;

/** Default map view when a mission has no plan yet (Belgrade, Serbia). */
export const DEFAULT_CENTER: GeoPoint = { lat: 44.7866, lng: 20.4489 };
export const DEFAULT_ZOOM = 12;

/** Assumed drone cruise speed for the flight-time estimate. */
const CRUISE_MPS = 9;
const EARTH_R = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

export function pathMeters(wps: GeoPoint[]): number {
  let d = 0;
  for (let i = 1; i < wps.length; i++) {
    d += distanceMeters(wps[i - 1], wps[i]);
  }
  return d;
}

export function distanceText(wps: GeoPoint[]): string {
  const m = pathMeters(wps);
  return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
}

export function durationText(wps: GeoPoint[]): string {
  return Math.max(0, Math.round(pathMeters(wps) / CRUISE_MPS / 60)) + " min";
}

export function centroid(wps: GeoPoint[]): GeoPoint {
  const s = wps.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), {
    lat: 0,
    lng: 0,
  });
  return { lat: s.lat / wps.length, lng: s.lng / wps.length };
}

/**
 * Ray-casting point-in-polygon, ported verbatim — including the `|| 1e-9`
 * guard that keeps a horizontal edge from dividing by zero.
 */
function pointInPolygon(p: GeoPoint, pts: GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].lng;
    const yi = pts[i].lat;
    const xj = pts[j].lng;
    const yj = pts[j].lat;
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi || 1e-9) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** A point with no zone is always in zone — mirrors the source's `!z` early return. */
export function inZone(p: GeoPoint, z: Geofence | null | undefined): boolean {
  if (!z) {
    return true;
  }
  if (z.type === "CIRCLE") {
    return distanceMeters(p, z.center) <= z.radiusMeters;
  }
  return pointInPolygon(p, z.points);
}

/** Clamp a point onto/into the zone; null only for a polygon point left outside. */
export function clampToZone(p: GeoPoint, z: Geofence | null | undefined): GeoPoint | null {
  if (!z) {
    return p;
  }
  if (z.type === "CIRCLE") {
    const d = distanceMeters(p, z.center);
    if (d <= z.radiusMeters) {
      return p;
    }
    // Move the point back onto the circle edge along the bearing from the centre.
    const k = z.radiusMeters / d;
    return {
      lat: z.center.lat + (p.lat - z.center.lat) * k,
      lng: z.center.lng + (p.lng - z.center.lng) * k,
    };
  }
  return pointInPolygon(p, z.points) ? p : null;
}

/** Small planar offset (good for the modest distances a flight zone spans). */
function offset(c: GeoPoint, angleRad: number, meters: number): GeoPoint {
  const dLat = (meters * Math.cos(angleRad)) / 111_320;
  const dLng = (meters * Math.sin(angleRad)) / (111_320 * Math.cos(toRad(c.lat)));
  return { lat: c.lat + dLat, lng: c.lng + dLng };
}

export function defaultGeofence(center: GeoPoint = DEFAULT_CENTER): CircleZone {
  return { type: "CIRCLE", center: { ...center }, radiusMeters: 1200 };
}

/** Smallest circle enclosing the waypoints (+ padding). */
export function enclosingCircle(wps: GeoPoint[], padMeters = 250): CircleZone {
  if (!wps.length) {
    return defaultGeofence();
  }
  const center = centroid(wps);
  let r = 0;
  for (const p of wps) {
    r = Math.max(r, distanceMeters(center, p));
  }
  return { type: "CIRCLE", center, radiusMeters: Math.round(r + padMeters) };
}

export function zoneToCircle(z: Geofence | null): Geofence {
  if (z && z.type === "CIRCLE") {
    return z;
  }
  if (z && z.type === "POLYGON") {
    const c = enclosingCircle(z.points, 0);
    return { type: "CIRCLE", center: c.center, radiusMeters: Math.max(200, c.radiusMeters) };
  }
  return defaultGeofence();
}

export function zoneToPolygon(z: Geofence | null): Geofence {
  if (z && z.type === "POLYGON") {
    return z;
  }
  const c = z && z.type === "CIRCLE" ? z : defaultGeofence();
  const points: GeoPoint[] = [];
  for (let k = 0; k < 6; k++) {
    points.push(offset(c.center, -Math.PI / 2 + (k * Math.PI) / 3, c.radiusMeters));
  }
  return { type: "POLYGON", points };
}
