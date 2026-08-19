"use client";

import { useCallback, useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { WAYPOINT_ACTION_LABELS } from "../mission.client";
import type { Waypoint, WaypointAction } from "../mission.types";

/**
 * Captures a waypoint's altitude and drone action. Ports
 * `WaypointDialogComponent` (template, styles and validators included).
 *
 * Controlled via `open`; calls `onSave` with the collected values or
 * `onCancel`. Escape and a backdrop click both cancel. Pass `initial` to edit
 * an existing waypoint, `null` to create one.
 *
 * The validation mirrors the Angular form's validators — and, through them,
 * the backend's rules that `mission.schema.ts` ports (`altitude` positive and
 * ≤ 120; `hoverDurationSeconds` required, positive and whole for HOVER, absent
 * for every other action). Messages are the source's, verbatim.
 *
 * SOURCE: drone-missions-frontend/.../components/waypoint-dialog/waypoint-dialog.component.{ts,html,css}
 */

/** What the dialog collects for a waypoint — the fields the backend requires. */
export interface WaypointDetails {
  altitude: number;
  action: WaypointAction;
  hoverDurationSeconds?: number;
}

export interface WaypointDialogProps {
  open: boolean;
  initial?: Waypoint | null;
  onSave: (details: WaypointDetails) => void;
  onCancel: () => void;
}

/** Metres; the backend caps a waypoint at this altitude. */
const MAX_ALTITUDE = 120;

/** Offered in declaration order, exactly as the source's `Object.keys` does. */
const ACTIONS = Object.keys(WAYPOINT_ACTION_LABELS) as WaypointAction[];

/** Ports the `positive` validator: blank is left to `required`, 0 is rejected. */
function isPositive(value: string): boolean {
  return value === "" || Number(value) > 0;
}

/** Ports the `wholeNumber` validator — the backend's hover duration is whole seconds. */
function isWholeNumber(value: string): boolean {
  return value === "" || Number.isInteger(Number(value));
}

export function WaypointDialog({ open, initial = null, onSave, onCancel }: WaypointDialogProps) {
  const [altitude, setAltitude] = useState("");
  const [action, setAction] = useState<WaypointAction | "">("");
  const [hoverDurationSeconds, setHoverDurationSeconds] = useState("");
  const [touched, setTouched] = useState({ altitude: false, action: false, hover: false });

  /**
   * `ngOnChanges` -> reset the form whenever the dialog is (re)opened or is
   * handed a different waypoint to edit. `form.reset()` clears the touched
   * flags too, so they are reset here as well.
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    setAltitude(initial?.altitude != null ? String(initial.altitude) : "");
    setAction(initial?.action ?? "");
    setHoverDurationSeconds(
      initial?.hoverDurationSeconds != null ? String(initial.hoverDurationSeconds) : "",
    );
    setTouched({ altitude: false, action: false, hover: false });
  }, [open, initial]);

  const cancel = useCallback(() => onCancel(), [onCancel]);

  /** `@HostListener('document:keydown.escape')` — escape cancels while open. */
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        cancel();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, cancel]);

  if (!open) {
    return null;
  }

  const isHover = action === "HOVER";

  // Error precedence matches the template's `@if / @else if` chains.
  const altitudeError =
    altitude === ""
      ? "Altitude is required."
      : !isPositive(altitude)
        ? "Altitude must be greater than 0."
        : Number(altitude) > MAX_ALTITUDE
          ? `Altitude can't be above ${MAX_ALTITUDE} m.`
          : null;
  const actionError = action === "" ? "Pick what the drone should do here." : null;
  const hoverError = !isHover
    ? null
    : hoverDurationSeconds === ""
      ? "Hover duration is required."
      : !isPositive(hoverDurationSeconds)
        ? "Hover duration must be greater than 0."
        : !isWholeNumber(hoverDurationSeconds)
          ? "Hover duration must be a whole number of seconds."
          : null;

  /**
   * The duration is dropped for every action other than HOVER — mirrors
   * `syncHoverField`, which clears the control's value as well as its
   * validators (the backend rejects a duration on a non-HOVER waypoint).
   */
  function changeAction(next: WaypointAction | "") {
    setAction(next);
    if (next !== "HOVER") {
      setHoverDurationSeconds("");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (altitudeError || actionError || hoverError) {
      setTouched({ altitude: true, action: true, hover: true });
      return;
    }
    if (action === "") {
      return;
    }
    onSave(
      action === "HOVER"
        ? { altitude: Number(altitude), action, hoverDurationSeconds: Number(hoverDurationSeconds) }
        : { altitude: Number(altitude), action },
    );
  }

  /** Cancel only when the backdrop itself is clicked, not the card above it. */
  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      cancel();
    }
  }

  const title = initial ? "Edit waypoint" : "New waypoint";
  const fieldClass =
    "border-input bg-secondary/40 text-foreground placeholder:text-muted-foreground/70 focus:border-ring w-full rounded-lg border px-3 py-2.5 text-sm transition-colors outline-none focus:bg-transparent";
  const labelClass = "text-muted-foreground text-[10.5px] font-medium tracking-wide uppercase";

  return (
    <div
      role="presentation"
      onClick={handleBackdrop}
      className="animate-in fade-in-0 fixed inset-0 z-[2000] flex items-center justify-center bg-[rgba(20,30,45,0.45)] p-5 backdrop-blur-[3px] motion-reduce:animate-none"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={handleSubmit}
        noValidate
        className="border-border bg-card animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 w-full max-w-[400px] rounded-2xl border px-[26px] pt-[26px] pb-[22px] text-center shadow-[0_20px_60px_rgba(20,35,55,0.28)] motion-reduce:animate-none"
      >
        <div
          aria-hidden="true"
          className="text-primary bg-primary/10 mx-auto mb-3.5 flex h-[46px] w-[46px] items-center justify-center rounded-full"
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" />
            <circle cx="12" cy="10" r="2.5" />
          </svg>
        </div>

        <h2 className="text-foreground mb-2 text-lg font-bold tracking-tight">{title}</h2>
        <p className="text-muted-foreground mb-5 text-sm leading-relaxed">
          How high the drone flies here, and what it does when it arrives.
        </p>

        <div className="mb-4 flex flex-col gap-1.5 text-left">
          <label htmlFor="waypoint-altitude" className={labelClass}>
            Altitude (m)
          </label>
          <input
            id="waypoint-altitude"
            type="number"
            min="1"
            max={MAX_ALTITUDE}
            step="1"
            placeholder="e.g. 60"
            value={altitude}
            onChange={(event) => setAltitude(event.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, altitude: true }))}
            className={cn(
              fieldClass,
              touched.altitude && altitudeError && "border-destructive focus:border-destructive",
            )}
          />
          {touched.altitude && altitudeError && (
            <p className="text-destructive text-xs">{altitudeError}</p>
          )}
        </div>

        <div className="mb-4 flex flex-col gap-1.5 text-left">
          <label htmlFor="waypoint-action" className={labelClass}>
            Action
          </label>
          <select
            id="waypoint-action"
            value={action}
            onChange={(event) => changeAction(event.target.value as WaypointAction | "")}
            onBlur={() => setTouched((current) => ({ ...current, action: true }))}
            className={cn(
              fieldClass,
              "cursor-pointer appearance-none",
              touched.action && actionError && "border-destructive focus:border-destructive",
            )}
          >
            <option value="" disabled>
              Choose an action…
            </option>
            {ACTIONS.map((option) => (
              <option key={option} value={option}>
                {WAYPOINT_ACTION_LABELS[option]}
              </option>
            ))}
          </select>
          {touched.action && actionError && (
            <p className="text-destructive text-xs">{actionError}</p>
          )}
        </div>

        {isHover && (
          <div className="mb-4 flex flex-col gap-1.5 text-left">
            <label htmlFor="waypoint-hover" className={labelClass}>
              Hover duration (s)
            </label>
            <input
              id="waypoint-hover"
              type="number"
              min="1"
              step="1"
              placeholder="e.g. 30"
              value={hoverDurationSeconds}
              onChange={(event) => setHoverDurationSeconds(event.target.value)}
              onBlur={() => setTouched((current) => ({ ...current, hover: true }))}
              className={cn(
                fieldClass,
                touched.hover && hoverError && "border-destructive focus:border-destructive",
              )}
            />
            {touched.hover && hoverError && (
              <p className="text-destructive text-xs">{hoverError}</p>
            )}
          </div>
        )}

        <div className="mt-1 flex gap-2.5">
          <button
            type="button"
            onClick={cancel}
            className="border-input text-muted-foreground hover:text-foreground flex-1 cursor-pointer rounded-[9px] border bg-transparent px-4 py-2.5 text-sm font-semibold transition-colors hover:border-current"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="bg-primary text-primary-foreground hover:bg-primary/90 flex-1 cursor-pointer rounded-[9px] border border-transparent px-4 py-2.5 text-sm font-semibold shadow-[0_3px_12px_rgba(47,107,255,0.28)] transition-colors"
          >
            {initial ? "Save waypoint" : "Add waypoint"}
          </button>
        </div>
      </form>
    </div>
  );
}
