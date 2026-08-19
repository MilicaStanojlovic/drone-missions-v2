"use client";

import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/utils";
import { WAYPOINT_ACTION_ICONS, WAYPOINT_ACTION_LABELS } from "../mission.client";
import { DEFAULT_CENTER, DEFAULT_ZOOM, clampToZone, distanceMeters, inZone } from "../mission.geo";
import type { GeoPoint, Geofence, Waypoint } from "../mission.types";

/**
 * The flight map, on Leaflet (OpenStreetMap tiles, real lat/lng). Ports
 * `MissionMapComponent`.
 *
 * Controlled component: it calls `onWaypointsChange` / `onGeofenceChange` and
 * expects the parent to feed the new values back — it never mutates its props.
 * In `editable` + `mode="add"` a map click appends a waypoint; in
 * `mode="select"` markers drag (right-click removes) and the flight zone gets
 * drag handles. Read-only otherwise (still pannable/zoomable).
 *
 * Adding is a two-step flow owned by the parent: a map click reports
 * `onWaypointAdd` (the parent collects altitude/action via the waypoint
 * dialog, then feeds `waypoints` back), and clicking an existing marker
 * reports `onWaypointEdit` with its index.
 *
 * This module is never rendered on the server: `mission-map.tsx` loads it
 * through `next/dynamic` with `ssr: false`, because Leaflet touches `window`
 * and `document` at import time. Import it from there, not directly.
 *
 * The Angular original is imperative already (it drives Leaflet from
 * lifecycle hooks), so the port keeps that shape rather than reaching for a
 * React wrapper library: `ngAfterViewInit` becomes the mount effect, the
 * `ngOnChanges`-driven `render()` becomes the draw effect below, and
 * `ngOnDestroy`'s `map.remove()` becomes the mount effect's cleanup.
 *
 * SOURCE: drone-missions-frontend/.../components/mission-map/mission-map.component.ts
 */

const ZONE_COLOR = "#6d5ef0";

/** Stable empty default, so an omitted `waypoints` prop doesn't redraw every render. */
const NO_WAYPOINTS: Waypoint[] = [];

export type MissionMapMode = "add" | "select" | "pan";

export interface MissionMapProps {
  waypoints?: Waypoint[];
  geofence?: Geofence | null;
  editable?: boolean;
  mode?: MissionMapMode;
  /** When false the map is a static thumbnail: no pan/zoom/controls, clicks pass through. */
  interactive?: boolean;
  /** Sizing/positioning for the map element — it fills whatever box it is given. */
  className?: string;
  onWaypointsChange?: (waypoints: Waypoint[]) => void;
  /** A click on empty map in `add` mode — the parent decides what to append. */
  onWaypointAdd?: (point: GeoPoint) => void;
  /** A click on an existing marker, by index. */
  onWaypointEdit?: (index: number) => void;
  onGeofenceChange?: (geofence: Geofence) => void;
  onOutOfZone?: () => void;
}

export function MissionMapView({
  waypoints = NO_WAYPOINTS,
  geofence = null,
  editable = false,
  mode = "add",
  interactive = true,
  className,
  onWaypointsChange,
  onWaypointAdd,
  onWaypointEdit,
  onGeofenceChange,
  onOutOfZone,
}: MissionMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const planRef = useRef<L.LayerGroup | null>(null);
  const pathLineRef = useRef<L.Polyline | null>(null);
  const zoneShapeRef = useRef<L.Circle | L.Polygon | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const fittedRef = useRef(false);
  const [ready, setReady] = useState(false);

  /**
   * Latest props, readable from Leaflet handlers that outlive the render that
   * registered them (the map's `click`, above all). The Angular original gets
   * this for free — its handlers read `this.<input>`, which is always current
   * — so mirroring it takes a ref here. Written during render so both effects
   * below see current values.
   */
  const propsRef = useRef({ waypoints, geofence, editable, mode });
  propsRef.current = { waypoints, geofence, editable, mode };
  const handlersRef = useRef({
    onWaypointsChange,
    onWaypointAdd,
    onWaypointEdit,
    onGeofenceChange,
    onOutOfZone,
  });
  handlersRef.current = {
    onWaypointsChange,
    onWaypointAdd,
    onWaypointEdit,
    onGeofenceChange,
    onOutOfZone,
  };

  // ---- map lifecycle (ngAfterViewInit / ngOnDestroy) ----
  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const options: L.MapOptions = {
      center: [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
      zoom: DEFAULT_ZOOM,
    };
    if (!interactive) {
      // Static thumbnail — kill every interaction handler and chrome, keep just the tiles + route.
      Object.assign(options, {
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        touchZoom: false,
        keyboard: false,
        zoomControl: false,
        attributionControl: false,
      });
    }

    const map = L.map(element, options);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);
    const plan = L.layerGroup().addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => {
      const { editable: isEditable, mode: currentMode, geofence: zone } = propsRef.current;
      if (!isEditable || currentMode !== "add") {
        return;
      }
      const point: GeoPoint = { lat: event.latlng.lat, lng: event.latlng.lng };
      if (!inZone(point, zone)) {
        handlersRef.current.onOutOfZone?.();
        return;
      }
      handlersRef.current.onWaypointAdd?.(point);
    });
    const invalidate = window.setTimeout(() => map.invalidateSize(), 0);

    mapRef.current = map;
    planRef.current = plan;
    setReady(true);

    return () => {
      window.clearTimeout(invalidate);
      map.remove();
      mapRef.current = null;
      planRef.current = null;
      pathLineRef.current = null;
      zoneShapeRef.current = null;
      markersRef.current = [];
      fittedRef.current = false;
      setReady(false);
    };
    // `interactive` is fixed per call site (a feed thumbnail is never an
    // editor); rebuilding the map if it ever flipped is the honest reaction,
    // since the flag only takes effect in the constructor options above.
  }, [interactive]);

  // ---- rendering (render() / ngOnChanges) ----
  useEffect(() => {
    const map = mapRef.current;
    const plan = planRef.current;
    if (!ready || !map || !plan) {
      return;
    }

    // The helpers below are `const` arrows rather than the source's private
    // methods so that TypeScript keeps `map`/`plan` narrowed to non-null
    // inside them (a hoisted `function` could be called before the guard
    // above, so their narrowing would be discarded). The render body they
    // serve follows them, at the end of the effect.

    /** Marker positions merged back onto the waypoints, so altitude/action survive a drag. */
    const currentWaypoints = (): Waypoint[] =>
      markersRef.current.map((marker, index) => ({
        ...waypoints[index],
        lat: marker.getLatLng().lat,
        lng: marker.getLatLng().lng,
      }));

    const renderWaypoint = (waypoint: Waypoint, index: number): void => {
      const outside = geofence != null && !inZone(waypoint, geofence);
      const color = outside ? "#e04a3f" : index === 0 ? "#12a06a" : "#2f6bff";
      const draggable = editable && mode === "select";
      const marker = L.marker([waypoint.lat, waypoint.lng], {
        draggable,
        icon: waypointIcon(waypoint, index, color),
      });
      const tooltip = waypointTooltip(waypoint);
      if (tooltip) {
        marker.bindTooltip(tooltip, { direction: "top", offset: [0, -14], opacity: 0.95 });
      }
      if (editable) {
        marker.on("click", () => handlersRef.current.onWaypointEdit?.(index));
      }
      if (draggable) {
        marker.on("drag", () =>
          pathLineRef.current?.setLatLngs(markersRef.current.map((m) => m.getLatLng())),
        );
        marker.on("dragend", () => {
          const next = currentWaypoints().map((p) => {
            const clamped = clampToZone(p, geofence);
            return clamped ? { ...p, lat: clamped.lat, lng: clamped.lng } : p;
          });
          handlersRef.current.onWaypointsChange?.(next);
        });
        marker.on("contextmenu", () =>
          handlersRef.current.onWaypointsChange?.(waypoints.filter((_, idx) => idx !== index)),
        );
      }
      markersRef.current.push(marker);
      plan.addLayer(marker);
    };

    const renderZone = (): void => {
      const zone = geofence;
      if (!zone) {
        return;
      }
      const style: L.PathOptions = {
        color: ZONE_COLOR,
        weight: 2,
        dashArray: "8 6",
        fillColor: ZONE_COLOR,
        fillOpacity: 0.08,
      };
      if (zone.type === "CIRCLE") {
        const shape = L.circle([zone.center.lat, zone.center.lng], {
          radius: zone.radiusMeters,
          ...style,
        });
        zoneShapeRef.current = shape;
        plan.addLayer(shape);
        if (editable && mode === "select") {
          renderCircleHandles(zone);
        }
      } else {
        const shape = L.polygon(
          zone.points.map((p) => [p.lat, p.lng] as [number, number]),
          style,
        );
        zoneShapeRef.current = shape;
        plan.addLayer(shape);
        if (editable && mode === "select") {
          renderPolygonHandles(zone);
        }
      }
    };

    const renderCircleHandles = (zone: Extract<Geofence, { type: "CIRCLE" }>): void => {
      const center = L.marker([zone.center.lat, zone.center.lng], {
        draggable: true,
        icon: handleIcon(true),
      });
      // radius handle placed due east of the centre
      const edge = {
        lat: zone.center.lat,
        lng:
          zone.center.lng +
          zone.radiusMeters / (111_320 * Math.cos((zone.center.lat * Math.PI) / 180)),
      };
      const radius = L.marker([edge.lat, edge.lng], { draggable: true, icon: handleIcon(false) });

      center.on("drag", () => {
        (zoneShapeRef.current as L.Circle).setLatLng(center.getLatLng());
      });
      center.on("dragend", () => {
        const c = center.getLatLng();
        handlersRef.current.onGeofenceChange?.({
          type: "CIRCLE",
          center: { lat: c.lat, lng: c.lng },
          radiusMeters: zone.radiusMeters,
        });
      });
      radius.on("drag", () => {
        const shape = zoneShapeRef.current as L.Circle;
        const c = shape.getLatLng();
        shape.setRadius(
          Math.max(50, distanceMeters({ lat: c.lat, lng: c.lng }, radius.getLatLng())),
        );
      });
      radius.on("dragend", () => {
        const c = (zoneShapeRef.current as L.Circle).getLatLng();
        const r = Math.max(
          50,
          Math.round(distanceMeters({ lat: c.lat, lng: c.lng }, radius.getLatLng())),
        );
        handlersRef.current.onGeofenceChange?.({
          type: "CIRCLE",
          center: { lat: c.lat, lng: c.lng },
          radiusMeters: r,
        });
      });
      plan.addLayer(center);
      plan.addLayer(radius);
    };

    const renderPolygonHandles = (zone: Extract<Geofence, { type: "POLYGON" }>): void => {
      zone.points.forEach((point, index) => {
        const handle = L.marker([point.lat, point.lng], {
          draggable: true,
          icon: handleIcon(false),
        });
        handle.on("drag", () => {
          const points = zone.points.map((p, idx) =>
            idx === index ? handle.getLatLng() : L.latLng(p.lat, p.lng),
          );
          (zoneShapeRef.current as L.Polygon).setLatLngs(points);
        });
        handle.on("dragend", () => {
          const g = handle.getLatLng();
          const points = zone.points.map((p, idx) =>
            idx === index ? { lat: g.lat, lng: g.lng } : p,
          );
          handlersRef.current.onGeofenceChange?.({ type: "POLYGON", points });
        });
        plan.addLayer(handle);
      });
    };

    const fitToPlan = (): void => {
      const points: L.LatLngExpression[] = waypoints.map((p) => [p.lat, p.lng]);
      if (geofence?.type === "CIRCLE") {
        points.push([geofence.center.lat, geofence.center.lng]);
      } else if (geofence?.type === "POLYGON") {
        geofence.points.forEach((p) => points.push([p.lat, p.lng]));
      }
      if (points.length === 1) {
        map.setView(points[0], 14);
        fittedRef.current = true;
      } else if (points.length > 1) {
        map.fitBounds(L.latLngBounds(points).pad(0.25));
        fittedRef.current = true;
      }
    };

    // ---- the render pass itself, in the source's order ----
    plan.clearLayers();
    markersRef.current = [];
    pathLineRef.current = null;
    zoneShapeRef.current = null;

    renderZone();

    if (waypoints.length >= 2) {
      const pathLine = L.polyline(
        waypoints.map((p) => [p.lat, p.lng] as [number, number]),
        { color: "#2f6bff", weight: 3, opacity: 0.9, dashArray: "8 6" },
      );
      pathLineRef.current = pathLine;
      plan.addLayer(pathLine);
    }

    waypoints.forEach((waypoint, index) => renderWaypoint(waypoint, index));

    if (!fittedRef.current) {
      fitToPlan();
    }
  }, [ready, waypoints, geofence, editable, mode]);

  return (
    <div
      ref={containerRef}
      // `.map` / `.map--static` from the component's own styles: it fills the
      // box its parent gives it, and a static thumbnail lets clicks fall
      // through to the card link behind it.
      className={cn("h-full w-full bg-[#eef1ec]", !interactive && "pointer-events-none", className)}
    />
  );
}

/** Numbered pin, with an action badge clipped to its corner when the waypoint has one. */
function waypointIcon(waypoint: Waypoint, index: number, color: string): L.DivIcon {
  const pin =
    `<div style="width:26px;height:26px;border-radius:50%;background:#fff;border:2.5px solid ${color};` +
    `display:flex;align-items:center;justify-content:center;font:600 12px 'IBM Plex Mono',monospace;` +
    `color:${color};box-shadow:0 1px 3px rgba(20,35,55,.3)">${index + 1}</div>`;
  // Legacy waypoints carry no action — keep the plain marker.
  if (!waypoint.action) {
    return L.divIcon({ className: "", html: pin, iconSize: [26, 26], iconAnchor: [13, 13] });
  }
  const badge =
    `<div style="position:absolute;right:-5px;bottom:-4px;width:15px;height:15px;border-radius:50%;` +
    `background:${color};border:1.5px solid #fff;color:#fff;display:flex;align-items:center;` +
    `justify-content:center;box-shadow:0 1px 2px rgba(20,35,55,.35)">` +
    `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" ` +
    `stroke-linecap="round" stroke-linejoin="round">${WAYPOINT_ACTION_ICONS[waypoint.action]}</svg></div>`;
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:26px;height:26px">${pin}${badge}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/** `Hover 30 s · 60 m` — empty for legacy waypoints that carry neither field. */
function waypointTooltip(waypoint: Waypoint): string {
  const parts: string[] = [];
  if (waypoint.action) {
    const seconds =
      waypoint.action === "HOVER" && waypoint.hoverDurationSeconds
        ? ` ${waypoint.hoverDurationSeconds} s`
        : "";
    parts.push(`${WAYPOINT_ACTION_LABELS[waypoint.action]}${seconds}`);
  }
  if (waypoint.altitude != null) {
    parts.push(`${waypoint.altitude} m`);
  }
  return parts.join(" · ");
}

function handleIcon(filled: boolean): L.DivIcon {
  const bg = filled ? ZONE_COLOR : "#fff";
  const border = filled ? "#fff" : ZONE_COLOR;
  return L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${bg};border:2px solid ${border};box-shadow:0 1px 2px rgba(20,35,55,.3)"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}
