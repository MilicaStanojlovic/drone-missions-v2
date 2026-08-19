"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { MissionMap, type MissionMapMode } from "./mission-map";
import { WaypointDialog, type WaypointDetails } from "./waypoint-dialog";
import {
  ApiError,
  createMission,
  fetchMission,
  updateMission,
  type MissionPayload,
} from "../mission.client";
import {
  distanceText,
  durationText,
  enclosingCircle,
  zoneToCircle,
  zoneToPolygon,
} from "../mission.geo";
import type { GeoPoint, Geofence, GeofenceType, MissionStatus, Waypoint } from "../mission.types";

/**
 * The mission planner/editor: a Leaflet map pane (plot & adjust the flight
 * plan) beside a brief form. Ports `MissionFormComponent` — template, styles
 * and validators included.
 *
 * Both routes mount this one component, exactly as the Angular router does
 * (`missions/new` and `missions/:id/edit` share `MissionFormComponent`):
 * `missionId` absent is the create flow, present is the edit flow, which
 * loads the mission and prefills from it.
 *
 * The Angular reactive form becomes plain `useState` + derived error strings,
 * the same shape `components/login-form.tsx` and `waypoint-dialog.tsx`
 * already use in this app; `markAllAsTouched()` becomes one `setTouched` of
 * every flag. Every validator, message, guard and navigation target below is
 * the source's, verbatim.
 *
 * Ownership is not re-checked here: the edit flow simply asks the API for the
 * mission and lets the server decide — a mission the caller may not see is a
 * 404 (`loadError`), and someone else's mission is a 403 on save, whose
 * message is surfaced through the same `saveError` path as any other server
 * rejection. That is exactly what the Angular component does; the backend is
 * the authority in both ports.
 *
 * SOURCE: drone-missions-frontend/.../components/mission-form/mission-form.component.{ts,html,css}
 */

/** One undo step: the plan as it stood before the edit that pushed it. */
interface PlanSnapshot {
  waypoints: Waypoint[];
  geofence: Geofence | null;
}

/** Matches a per-waypoint validation key from the backend, e.g. `waypoints[0].altitude`. */
const WAYPOINT_FIELD = /^waypoints\[(\d+)\](?:\.\w+)?$/;

const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;

/** How many undo steps the editor keeps (`pushHistory`'s cap). */
const HISTORY_LIMIT = 50;

/** How long the out-of-zone warning stays up, in ms. */
const WARN_MS = 1600;

/** ISO-8601 -> `yyyy-MM-dd` for `<input type="date">`. */
function toDateInput(iso?: string | null): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `yyyy-MM-dd` (local midnight) -> ISO-8601, or undefined when empty. */
function fromDateInput(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value + "T00:00:00");
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Field -> message entries as display text: a nested `waypoints[i].<field>`
 * key becomes "Waypoint <i+1>: …" and sorts by that position, since the map
 * arrives unordered. Ports `fieldMessages`.
 */
function fieldMessages(data: Record<string, unknown>): string[] {
  return Object.entries(data)
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
    )
    .map(([field, message]) => {
      const index = WAYPOINT_FIELD.exec(field)?.[1];
      return index === undefined
        ? { position: -1, text: message }
        : { position: Number(index), text: `Waypoint ${Number(index) + 1}: ${message}` };
    })
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.text);
}

/**
 * Pulls a human message out of the API's `{ data, status, message }` error
 * body (`data` is a field -> message map, e.g. `{ waypoints: 'a flight path
 * needs at least 2 waypoints' }`), so server-side validation surfaces clearly
 * instead of the generic fallback. Ports `serverMessage`; the
 * `HttpErrorResponse` it unwraps is `ApiError` here (see `mission.client.ts`).
 */
function serverMessage(error: unknown): string | null {
  const body = error instanceof ApiError ? error.body : null;
  if (body && typeof body === "object") {
    const data = body.data;
    if (data && typeof data === "object") {
      const messages = fieldMessages(data as Record<string, unknown>);
      if (messages.length) {
        return messages.join(" ");
      }
    }
    const message = body.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return null;
}

export interface MissionFormProps {
  /** The mission being edited; omit (or null) for the create flow. */
  missionId?: number | null;
}

// ---- styling (the component's own CSS, as utility classes) ----

const BTN =
  "shrink-0 cursor-pointer rounded-lg border border-transparent px-4 py-[9px] text-[13.5px] font-medium transition-colors disabled:cursor-default disabled:opacity-60";
const BTN_PRIMARY = cn(
  BTN,
  "bg-primary text-primary-foreground font-semibold shadow-[0_3px_12px_rgba(47,107,255,0.26)] hover:enabled:bg-[#1e5ae6]",
);
const BTN_SOFT = cn(
  BTN,
  "border-input bg-secondary text-[#43525f] hover:enabled:border-[#c3ccd6] hover:enabled:bg-[#eaeff4]",
);
const BTN_DANGER_GHOST = cn(
  BTN,
  "bg-card border-[#f0d5d3] text-[#c0574d] hover:enabled:border-[#e5b0ab] hover:enabled:bg-[#fdf3f2]",
);
const SEG =
  "inline-flex items-center gap-1 rounded-[9px] border border-[#e2e8ef] bg-accent p-[3px]";
const SEG_BTN =
  "cursor-pointer rounded-[7px] bg-transparent px-[11px] py-1.5 text-[12.5px] text-[#5c6b7a] transition-colors";
const SEG_BTN_ACTIVE = "bg-card text-foreground shadow-[0_1px_2px_rgba(20,35,55,0.08)]";
const FIELD_LABEL =
  "mb-[7px] block font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase";
const FIELD_INPUT =
  "border-input bg-secondary/40 text-foreground placeholder:text-muted-foreground/70 focus:border-ring w-full rounded-lg border px-3 py-2.5 text-sm transition-colors outline-none focus:bg-transparent";
const FIELD_ERROR = "text-destructive text-xs";

export function MissionForm({ missionId = null }: MissionFormProps) {
  const router = useRouter();
  const isEdit = missionId !== null;

  const [currentStatus, setCurrentStatus] = useState<MissionStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [zoneWarn, setZoneWarn] = useState(false);
  const warnTimer = useRef<number | null>(null);

  // ---- plan (map) state ----
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [geofence, setGeofence] = useState<Geofence | null>(null);
  const [mode, setMode] = useState<MissionMapMode>("add");
  const history = useRef<PlanSnapshot[]>([]);

  // ---- waypoint modal state ----
  /** Where a new waypoint goes once the modal collects its altitude/action. */
  const [pendingPoint, setPendingPoint] = useState<GeoPoint | null>(null);
  /** Index of the waypoint being edited, null when adding. */
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // ---- the brief form ----
  const [values, setValues] = useState({
    name: "",
    location: "",
    description: "",
    startDate: "",
    endDate: "",
    biddingDeadline: "",
  });
  const [touched, setTouched] = useState({
    name: false,
    description: false,
    startDate: false,
    endDate: false,
  });

  const setValue = (field: keyof typeof values, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));
  const touch = (field: keyof typeof touched) =>
    setTouched((current) => ({ ...current, [field]: true }));
  /** `form.markAllAsTouched()`. */
  const touchAll = () =>
    setTouched({ name: true, description: true, startDate: true, endDate: true });

  // ---- loading the mission being edited (ngOnInit -> loadMission) ----
  useEffect(() => {
    if (missionId === null) {
      return;
    }
    let cancelled = false;
    fetchMission(missionId)
      .then((mission) => {
        if (cancelled) {
          return;
        }
        setCurrentStatus(mission.status);
        setWaypoints(mission.waypoints ?? []);
        setGeofence(mission.geofence ?? null);
        setValues({
          name: mission.name ?? "",
          description: mission.description ?? "",
          location: mission.location ?? "",
          startDate: toDateInput(mission.startTime),
          endDate: toDateInput(mission.endTime),
          biddingDeadline: mission.biddingDeadline ?? "",
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        console.error("Failed to load mission", error);
        setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  // The out-of-zone warning's timer must not outlive the editor.
  useEffect(
    () => () => {
      if (warnTimer.current !== null) {
        window.clearTimeout(warnTimer.current);
      }
    },
    [],
  );

  // ---- validation (the form's validators, as derived errors) ----
  // `notBlank` fails only for a non-empty, all-whitespace value, so `required`
  // keeps reporting the empty case — the template's error precedence.
  const nameError =
    values.name.length === 0
      ? "Title is required."
      : values.name.trim().length === 0
        ? "Title can't be only spaces."
        : null;
  const descriptionError =
    values.description.length === 0
      ? "Description is required."
      : values.description.trim().length === 0
        ? "Description can't be only spaces."
        : null;
  const datesMissing = !values.startDate || !values.endDate;
  const endBeforeStart =
    !!values.startDate &&
    !!values.endDate &&
    new Date(values.endDate).getTime() < new Date(values.startDate).getTime();
  /**
   * `form.invalid`. The two length rules are part of it even though the
   * template renders no message for either: the `maxlength` attributes keep a
   * typed value inside the cap, but a mission loaded from the server can
   * exceed it (the backend caps neither `name` nor, above 2000, the
   * description), and the source blocks the save silently in exactly that
   * case. Mirrored rather than "fixed" — parity first.
   */
  const formInvalid =
    nameError !== null ||
    values.name.length > MAX_NAME ||
    descriptionError !== null ||
    values.description.length > MAX_DESCRIPTION ||
    datesMissing ||
    endBeforeStart;

  // ---- readouts / checklist ----
  const hasTitle = values.name.trim().length > 0;
  const hasWaypoints = waypoints.length >= 2;
  /**
   * 1-based positions of waypoints still missing an altitude or an action.
   * Missions planned before those fields existed load with both null, and the
   * backend rejects them on save.
   */
  const incompleteWaypointPositions = waypoints
    .map((waypoint, index) =>
      waypoint.altitude == null || waypoint.action == null ? index + 1 : 0,
    )
    .filter((position) => position > 0);
  const waypointsComplete = waypoints.length > 0 && incompleteWaypointPositions.length === 0;
  const zoneType: GeofenceType | null = geofence?.type ?? null;

  /** Snapshots the plan so `undo()` can restore it. */
  const pushHistory = useCallback(() => {
    history.current.push({ waypoints, geofence });
    if (history.current.length > HISTORY_LIMIT) {
      history.current.shift();
    }
  }, [waypoints, geofence]);

  // ---- map events ----
  const onWaypoints = useCallback(
    (next: Waypoint[]) => {
      if (next.length !== waypoints.length) {
        pushHistory();
      }
      setWaypoints(next);
    },
    [waypoints.length, pushHistory],
  );

  const onWaypointAdd = useCallback((point: GeoPoint) => {
    setEditingIndex(null);
    setPendingPoint(point);
  }, []);

  const onWaypointEdit = useCallback((index: number) => {
    setPendingPoint(null);
    setEditingIndex(index);
  }, []);

  const onGeofence = useCallback((next: Geofence) => setGeofence(next), []);

  const onOutOfZone = useCallback(() => {
    setZoneWarn(true);
    if (warnTimer.current !== null) {
      window.clearTimeout(warnTimer.current);
    }
    warnTimer.current = window.setTimeout(() => setZoneWarn(false), WARN_MS);
  }, []);

  // ---- waypoint modal ----
  const waypointDialogOpen = pendingPoint !== null || editingIndex !== null;
  /** The waypoint the modal prefills from; null when adding a new one. */
  const editingWaypoint = editingIndex === null ? null : (waypoints[editingIndex] ?? null);

  const closeWaypointDialog = useCallback(() => {
    setPendingPoint(null);
    setEditingIndex(null);
  }, []);

  const onWaypointSave = useCallback(
    (details: WaypointDetails) => {
      if (editingIndex === null && pendingPoint === null) {
        return;
      }
      pushHistory();
      if (editingIndex !== null) {
        // Rebuilt, not spread over the old waypoint, so a stale hover duration
        // can't survive an action change.
        setWaypoints((current) =>
          current.map((waypoint, index) =>
            index === editingIndex
              ? { lat: waypoint.lat, lng: waypoint.lng, ...details }
              : waypoint,
          ),
        );
      } else if (pendingPoint !== null) {
        setWaypoints((current) => [...current, { ...pendingPoint, ...details }]);
      }
      closeWaypointDialog();
    },
    [editingIndex, pendingPoint, pushHistory, closeWaypointDialog],
  );

  // ---- toolbar ----
  /** Circle/Polygon build (or convert) a flight zone that encloses the waypoints. */
  function setZone(type: GeofenceType): void {
    if (!geofence && !waypoints.length) {
      return; // nothing to enclose yet
    }
    const base = geofence ?? enclosingCircle(waypoints);
    pushHistory();
    setGeofence(type === "CIRCLE" ? zoneToCircle(base) : zoneToPolygon(base));
  }

  function clearZone(): void {
    if (!geofence) {
      return;
    }
    pushHistory();
    setGeofence(null);
  }

  function undo(): void {
    const previous = history.current.pop();
    if (previous) {
      setWaypoints(previous.waypoints);
      setGeofence(previous.geofence);
    }
  }

  function clearPlan(): void {
    if (!waypoints.length && !geofence) {
      return;
    }
    pushHistory();
    setWaypoints([]);
    setGeofence(null);
  }

  // ---- save ----
  function cancel(): void {
    router.push(isEdit && missionId !== null ? `/missions/${missionId}` : "/missions/mine");
  }

  async function save(status: MissionStatus): Promise<void> {
    if (formInvalid) {
      touchAll();
      return;
    }
    if (waypoints.length < 2) {
      setSaveError(
        "Draw a flight path with at least 2 waypoints — a single point or an empty path can’t be saved.",
      );
      return;
    }
    const incomplete = incompleteWaypointPositions;
    if (incomplete.length > 0) {
      setSaveError(
        incomplete.length === 1
          ? `Waypoint ${incomplete[0]} needs an altitude and an action — click its marker to set them.`
          : `Waypoints ${incomplete.join(", ")} need an altitude and an action — click their markers to set them.`,
      );
      return;
    }
    const startTime = fromDateInput(values.startDate);
    const endTime = fromDateInput(values.endDate);
    if (startTime === undefined || endTime === undefined) {
      // Unreachable: both dates are `required`, so `formInvalid` above has
      // already returned. Present so the payload's required instants stay
      // non-optional rather than being asserted.
      return;
    }
    const payload: MissionPayload = {
      name: values.name.trim(),
      description: values.description.trim(),
      status,
      startTime,
      endTime,
      location: values.location.trim() || undefined,
      biddingDeadline: values.biddingDeadline || undefined,
      waypoints,
      geofence,
    };

    setSubmitting(true);
    setSaveError(null);
    try {
      const saved =
        isEdit && missionId !== null
          ? await updateMission(missionId, payload)
          : await createMission(payload);
      router.push(`/missions/${saved.id}`);
    } catch (error: unknown) {
      console.error("Failed to save mission", error);
      setSaveError(serverMessage(error) ?? "Could not save the mission. Please try again.");
      setSubmitting(false);
    }
  }

  function saveAsDraft(): void {
    void save("DRAFT");
  }

  function publish(): void {
    if (!hasTitle || !hasWaypoints) {
      touchAll();
      setSaveError("Add a title and at least 2 waypoints before publishing.");
      return;
    }
    void save("PUBLISHED");
  }

  function saveChanges(): void {
    if (currentStatus === null) {
      return;
    }
    void save(currentStatus);
  }

  if (loadError) {
    return (
      <div className="mx-auto mt-[60px] max-w-[520px] px-5 text-center">
        <h1 className="text-foreground mb-2 text-[22px] font-bold tracking-tight">
          Mission not found
        </h1>
        <p className="mb-5 text-[#5c6b7a]">
          We couldn&apos;t load this mission for editing. It may have been deleted.
        </p>
        <button type="button" className={BTN_SOFT} onClick={cancel}>
          ← Back to My Missions
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex min-h-[480px] flex-col min-[900px]:h-[calc(100vh-60px)]">
        {/* header bar */}
        <div className="border-border bg-card flex shrink-0 flex-wrap items-center justify-between gap-4 border-b px-[22px] py-[13px]">
          <div className="flex items-center gap-3.5">
            <button type="button" className={BTN_SOFT} onClick={cancel}>
              ← Back
            </button>
            <div>
              <div className="text-[17px] font-semibold text-[#141e28]">
                {isEdit ? "Edit mission" : "New mission"}
              </div>
              <div className="mt-0.5 font-mono text-[11px] tracking-[0.06em] text-[#93a1b0]">
                CLICK MAP TO ADD · DRAG TO MOVE · RIGHT-CLICK A NODE TO REMOVE
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {!isEdit ? (
              <>
                <button
                  type="button"
                  className={BTN_SOFT}
                  disabled={submitting}
                  onClick={saveAsDraft}
                >
                  Save as Draft
                </button>
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  disabled={submitting}
                  onClick={publish}
                >
                  {submitting ? "Saving…" : "Publish"}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={submitting}
                onClick={saveChanges}
              >
                {submitting ? "Saving…" : "Save changes"}
              </button>
            )}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 min-[900px]:grid-cols-[1fr_384px]">
          {/* map pane */}
          <div className="border-border flex min-h-0 flex-col border-b bg-[#f5f7fa] min-[900px]:border-r min-[900px]:border-b-0">
            <div className="flex shrink-0 flex-wrap items-center gap-3.5 border-b border-[#e8edf2] px-[18px] py-[11px]">
              <div className={SEG}>
                {(
                  [
                    ["add", "+ Add node"],
                    ["select", "Move / edit"],
                    ["pan", "Pan"],
                  ] as [MissionMapMode, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={cn(SEG_BTN, mode === value && SEG_BTN_ACTIVE)}
                    onClick={() => setMode(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] tracking-[0.1em] text-[#93a1b0]">ZONE</span>
                <div className={SEG}>
                  <button
                    type="button"
                    className={cn(SEG_BTN, zoneType === "CIRCLE" && SEG_BTN_ACTIVE)}
                    onClick={() => setZone("CIRCLE")}
                  >
                    ◯ Circle
                  </button>
                  <button
                    type="button"
                    className={cn(SEG_BTN, zoneType === "POLYGON" && SEG_BTN_ACTIVE)}
                    onClick={() => setZone("POLYGON")}
                  >
                    ⬡ Polygon
                  </button>
                  <button
                    type="button"
                    className={cn(SEG_BTN, zoneType === null && SEG_BTN_ACTIVE)}
                    onClick={clearZone}
                  >
                    None
                  </button>
                </div>
              </div>

              <div className="ml-auto flex items-center gap-2">
                <button type="button" className={BTN_SOFT} onClick={undo}>
                  Undo
                </button>
                <button type="button" className={BTN_DANGER_GHOST} onClick={clearPlan}>
                  Clear
                </button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-[18px]">
              {/* The wrap keeps the map's 1000×640 aspect and, on a wide
                  viewport, caps its width so the pane never overflows
                  vertically (`.editor__map-wrap`; the cap is lifted below
                  900px, where the panes stack). */}
              <div className="relative aspect-[1000/640] w-full max-w-none overflow-hidden rounded-[10px] border border-[#d3dbe3] shadow-[0_1px_2px_rgba(20,35,55,0.06),0_14px_40px_rgba(20,35,55,0.12)] min-[900px]:max-w-[calc((100vh-260px)*1.5625)]">
                <MissionMap
                  editable
                  mode={mode}
                  waypoints={waypoints}
                  geofence={geofence}
                  onWaypointsChange={onWaypoints}
                  onWaypointAdd={onWaypointAdd}
                  onWaypointEdit={onWaypointEdit}
                  onGeofenceChange={onGeofence}
                  onOutOfZone={onOutOfZone}
                />
              </div>
            </div>

            <div className="bg-card flex shrink-0 flex-wrap items-center gap-[22px] border-t border-[#e8edf2] px-[18px] py-[11px] font-mono text-[11.5px]">
              <div>
                <span className="text-[#a2afbc]">WAYPOINTS</span>{" "}
                <span className="text-primary font-semibold">{waypoints.length}</span>
              </div>
              <div>
                <span className="text-[#a2afbc]">PATH</span>{" "}
                <span className="text-foreground">{distanceText(waypoints)}</span>
              </div>
              <div>
                <span className="text-[#a2afbc]">EST. FLIGHT</span>{" "}
                <span className="text-foreground">{durationText(waypoints)}</span>
              </div>
              {zoneWarn && (
                <div role="status" className="font-sans text-xs text-[#c0574d]">
                  Waypoint must be inside the flight zone
                </div>
              )}
            </div>
          </div>

          {/* brief form pane */}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (isEdit) {
                saveChanges();
              } else {
                publish();
              }
            }}
            className="bg-card overflow-y-auto px-[22px] pt-[22px] pb-10"
          >
            <div className="mb-[18px] font-mono text-[11px] tracking-[0.12em] text-[#a2afbc]">
              MISSION BRIEF
            </div>

            <div className="mb-[18px]">
              <label htmlFor="mission-name" className={FIELD_LABEL}>
                Title
              </label>
              <input
                id="mission-name"
                type="text"
                maxLength={MAX_NAME}
                placeholder="e.g. Rooftop Solar Inspection"
                value={values.name}
                onChange={(event) => setValue("name", event.target.value)}
                onBlur={() => touch("name")}
                className={cn(
                  FIELD_INPUT,
                  touched.name && nameError && "border-destructive focus:border-destructive",
                )}
              />
              {touched.name && nameError && (
                <p className={cn(FIELD_ERROR, "mt-1.5")}>{nameError}</p>
              )}
            </div>

            <div className="mb-[18px]">
              <label htmlFor="mission-location" className={FIELD_LABEL}>
                Location
              </label>
              <input
                id="mission-location"
                type="text"
                placeholder="City, State"
                value={values.location}
                onChange={(event) => setValue("location", event.target.value)}
                className={FIELD_INPUT}
              />
            </div>

            <div className="mb-[18px]">
              <label htmlFor="mission-description" className={FIELD_LABEL}>
                Description
              </label>
              <textarea
                id="mission-description"
                rows={4}
                maxLength={MAX_DESCRIPTION}
                placeholder="What the pilot needs to know — altitude, pattern, constraints…"
                value={values.description}
                onChange={(event) => setValue("description", event.target.value)}
                onBlur={() => touch("description")}
                className={cn(
                  FIELD_INPUT,
                  "resize-y leading-relaxed break-words",
                  touched.description &&
                    descriptionError &&
                    "border-destructive focus:border-destructive",
                )}
              />
              <div className="mt-1.5 flex items-start justify-between gap-3">
                <span className={cn(FIELD_ERROR, "min-h-[1em]")}>
                  {touched.description && descriptionError}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[11px] text-[#9aa8b6]",
                    values.description.length >= MAX_DESCRIPTION && "font-semibold text-[#c0574d]",
                  )}
                >
                  {values.description.length}/{MAX_DESCRIPTION}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="mb-[18px]">
                <label htmlFor="mission-start" className={FIELD_LABEL}>
                  Start date
                </label>
                <input
                  id="mission-start"
                  type="date"
                  value={values.startDate}
                  onChange={(event) => setValue("startDate", event.target.value)}
                  onBlur={() => touch("startDate")}
                  className={cn(
                    FIELD_INPUT,
                    touched.startDate &&
                      !values.startDate &&
                      "border-destructive focus:border-destructive",
                  )}
                />
              </div>
              <div className="mb-[18px]">
                <label htmlFor="mission-end" className={FIELD_LABEL}>
                  End date
                </label>
                <input
                  id="mission-end"
                  type="date"
                  value={values.endDate}
                  onChange={(event) => setValue("endDate", event.target.value)}
                  onBlur={() => touch("endDate")}
                  className={cn(
                    FIELD_INPUT,
                    touched.endDate &&
                      (!values.endDate || endBeforeStart) &&
                      "border-destructive focus:border-destructive",
                  )}
                />
              </div>
            </div>
            {(touched.startDate && !values.startDate) || (touched.endDate && !values.endDate) ? (
              <p className={FIELD_ERROR}>Start and end dates are required.</p>
            ) : endBeforeStart && touched.endDate ? (
              <p className={FIELD_ERROR}>End date can&apos;t be before the start date.</p>
            ) : null}

            <div className="mt-[18px] mb-[18px]">
              <label htmlFor="mission-bidding-deadline" className={FIELD_LABEL}>
                Bidding deadline
              </label>
              <input
                id="mission-bidding-deadline"
                type="date"
                value={values.biddingDeadline}
                onChange={(event) => setValue("biddingDeadline", event.target.value)}
                className={FIELD_INPUT}
              />
            </div>

            <div className="mt-1 rounded-[10px] border border-[#e8edf2] bg-[#f7f9fb] px-[15px] py-3.5 text-[12.5px] leading-[1.55] text-[#5c6b7a]">
              <div className="mb-[7px] font-mono text-[10px] tracking-[0.1em] text-[#a2afbc]">
                TO PUBLISH
              </div>
              {(
                [
                  [hasTitle, "A mission title"],
                  [hasWaypoints, "At least 2 waypoints on the map"],
                  [waypointsComplete, "An altitude and action on every waypoint"],
                ] as [boolean, string][]
              ).map(([done, label]) => (
                <div key={label} className="mb-1 flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn("font-semibold", done ? "text-[#12a06a]" : "text-[#c3ccd6]")}
                  >
                    {done ? "✓" : "○"}
                  </span>
                  {label}
                </div>
              ))}
            </div>

            {saveError && (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-[#f0d5d3] bg-[#fdf3f2] px-3 py-2.5 text-[13px] text-[#c0574d]"
              >
                {saveError}
              </p>
            )}
          </form>
        </div>
      </div>

      <WaypointDialog
        open={waypointDialogOpen}
        initial={editingWaypoint}
        onSave={onWaypointSave}
        onCancel={closeWaypointDialog}
      />
    </>
  );
}
