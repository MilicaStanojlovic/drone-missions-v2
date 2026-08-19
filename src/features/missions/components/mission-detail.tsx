"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { getRole, getUserId } from "@/features/auth/auth.client";
import { RatingStars } from "@/features/ratings/components/rating-stars";
import { MissionMap } from "./mission-map";
import {
  MISSION_LIFECYCLE,
  MISSION_STATUS_COLORS,
  MISSION_STATUS_LABELS,
  deleteMission,
  fetchMission,
  type Mission,
} from "../mission.client";
import { distanceText, durationText } from "../mission.geo";
import type { MissionStatus } from "../mission.types";

/**
 * One mission in full: status badge and lifecycle timeline, a read-only render
 * of the flight plan, telemetry, the brief, and the designer behind it — plus
 * Edit / Delete for the owning designer.
 *
 * Ports the phase-2 half of `MissionDetailComponent` — template, styles and
 * behaviour. Deliberately NOT ported yet, because the APIs behind them do not
 * exist in this app until later phases (a stubbed control that 404s is worse
 * parity than an absent one):
 * - the bids panel, the bid telemetry tile and the `from=my-bids` Back target
 *   (`BidService`, Phase 3);
 * - Start / Mark finished / Cancel mission (`MissionService.start/complete/cancel`,
 *   Phase 5);
 * - the ratings panel (`RatingService.forMission`, Phase 6).
 * The read-only status timeline IS ported: it is derived purely from
 * `mission.status`, which this phase's API already returns, and it is what
 * makes the status badge legible.
 *
 * Angular's `ngOnInit` + `route.paramMap.subscribe` becomes the load effect;
 * `auth.userId` / `auth.isDesigner` are read after mount because the JWT they
 * decode lives in `localStorage` (see `(app)/layout.tsx` for the same pattern).
 *
 * There is no toast service in this app yet, so the source's `toast.show(...)`
 * calls have no counterpart: a failed delete surfaces inline instead, and a
 * successful one is announced by the navigation itself, exactly as the source
 * navigates away.
 *
 * SOURCE: drone-missions-frontend/.../components/mission-detail/mission-detail.component.{ts,html,css}
 */

interface TimelineStep {
  status: MissionStatus;
  label: string;
  color: string;
  reached: boolean;
  current: boolean;
  last: boolean;
}

/** Feed filters carried in via the query string, replayed on Back to the feed. */
const FEED_PARAM_KEYS = ["keyword", "location", "date"] as const;

const BTN =
  "inline-flex cursor-pointer items-center rounded-lg border border-transparent px-[15px] py-[9px] text-[13px] font-medium no-underline transition-colors disabled:cursor-default disabled:opacity-60";
const BTN_SOFT = cn(BTN, "border-input bg-secondary text-[#43525f] hover:enabled:border-[#c3ccd6]");
const BTN_SOFT_LINK = cn(BTN, "border-input bg-secondary text-[#43525f] hover:border-[#c3ccd6]");
const BTN_DANGER = cn(BTN, "bg-[#e04a3f] font-semibold text-white hover:enabled:bg-[#c73c32]");

const CARD = "bg-card rounded-xl border border-[#e8edf2] shadow-[0_1px_2px_rgba(20,35,55,0.04)]";
const META_LABEL = "font-mono text-[9.5px] tracking-[0.08em] text-[#a2afbc] uppercase";

/** "Jul 18 – Jul 22" from the mission's flight window. Ports `windowText`. */
function windowText(mission: Mission): string {
  const fmt = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
  if (!mission.startTime && !mission.endTime) {
    return "TBD";
  }
  return `${fmt(mission.startTime)} – ${fmt(mission.endTime)}`;
}

/** The bidding deadline (a `yyyy-MM-dd` calendar date). Ports `deadlineText`. */
function deadlineText(mission: Mission): string {
  const deadline = mission.biddingDeadline;
  return deadline
    ? new Date(deadline + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "No deadline";
}

/** Ports the `steps` getter: a cancelled mission reaches nothing at all. */
function timelineSteps(status: MissionStatus): TimelineStep[] {
  const cancelled = status === "CANCELLED";
  const current = MISSION_LIFECYCLE.indexOf(status);
  return MISSION_LIFECYCLE.map((step, index) => ({
    status: step,
    label: MISSION_STATUS_LABELS[step],
    color: MISSION_STATUS_COLORS[step],
    reached: !cancelled && index <= current,
    current: !cancelled && index === current,
    last: index === MISSION_LIFECYCLE.length - 1,
  }));
}

export interface MissionDetailProps {
  /** The route's `:id` segment, already numeric — `Number(...)` as the source does. */
  missionId: number;
}

export function MissionDetail({ missionId }: MissionDetailProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [mission, setMission] = useState<Mission | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  /** Role and id come from the stored JWT, readable only after mount. */
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  useEffect(() => {
    setRole(getRole());
    setUserId(getUserId());
  }, []);

  // ---- load() ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchMission(missionId)
      .then((loaded) => {
        if (!cancelled) {
          setMission(loaded);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  const isPilot = role === "PILOT";
  /** Ports `isOwner`. A legacy ownerless mission (`userId: null`) has no owner. */
  const isOwner =
    role === "DESIGNER" && mission !== null && userId !== null && mission.userId === userId;

  /** Ports `backLabel` / `back()`; the `from=my-bids` branch lands in Phase 3 with /my-bids. */
  const backLabel = isPilot ? "Back to feed" : "My Missions";
  function back(): void {
    if (isPilot) {
      // Replay the feed filters so the marketplace comes back the way it was left.
      const params = new URLSearchParams();
      for (const key of FEED_PARAM_KEYS) {
        const value = searchParams.get(key);
        if (value) {
          params.set(key, value);
        }
      }
      const query = params.toString();
      router.push(query ? `/missions?${query}` : "/missions");
      return;
    }
    router.push("/missions/mine");
  }

  function confirmDelete(): void {
    setPendingDelete(false);
    if (!mission) {
      return;
    }
    setDeleteError(false);
    deleteMission(mission.id)
      .then(() => router.push("/missions/mine"))
      .catch(() => setDeleteError(true));
  }

  if (loading) {
    return (
      <p className="mx-auto max-w-[1240px] px-6 py-[60px] text-center text-[#6b7c8d]">
        Loading mission…
      </p>
    );
  }

  if (error || !mission) {
    return (
      <div className="mx-auto max-w-[1240px] px-6 py-[60px] text-center text-[#6b7c8d]">
        <h1 className="mb-2 text-[22px] font-bold text-[#141e28]">Mission not found</h1>
        <p className="mb-5">We couldn&apos;t load this mission. It may have been deleted.</p>
        <button type="button" className={BTN_SOFT} onClick={back}>
          ← {backLabel}
        </button>
      </div>
    );
  }

  const waypoints = mission.waypoints ?? [];
  const statusColor = MISSION_STATUS_COLORS[mission.status];

  return (
    <>
      <main className="text-foreground mx-auto max-w-[1240px] px-6 pt-[22px] pb-[72px]">
        <button
          type="button"
          className="cursor-pointer bg-transparent py-1.5 text-[13px] text-[#6b7c8d] hover:text-[#1b2732]"
          onClick={back}
        >
          ← {backLabel}
        </button>

        <div className="mt-[14px] mb-[18px] flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="mb-1.5 flex items-center gap-3">
              <span
                className="inline-flex items-center gap-1.5 rounded-[20px] border border-transparent px-2.5 py-1 font-mono text-[10px] font-semibold tracking-[0.1em] uppercase"
                style={{
                  color: statusColor,
                  background: `${statusColor}1a`,
                  borderColor: `${statusColor}55`,
                }}
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: statusColor }}
                />
                {MISSION_STATUS_LABELS[mission.status]}
              </span>
              {mission.location && (
                <span className="font-mono text-xs text-[#93a1b0]">{mission.location}</span>
              )}
            </div>
            <h1 className="m-0 max-w-[640px] text-[26px] font-bold tracking-[-0.01em] text-[#141e28]">
              {mission.name}
            </h1>
            {(mission.designerName ?? mission.designerEmail) && (
              <div className="mt-[7px] flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-[#93a1b0]">
                <span>
                  Designed by{" "}
                  <strong className="font-semibold text-[#46566a]">
                    {mission.designerName ?? mission.designerEmail}
                  </strong>
                </span>
                <RatingStars
                  average={mission.designerRating}
                  count={mission.designerRatingCount}
                  showEmpty={false}
                />
              </div>
            )}
          </div>
          {isOwner && (
            <div className="flex items-center gap-2.5">
              <Link href={`/missions/${mission.id}/edit`} className={BTN_SOFT_LINK}>
                Edit
              </Link>
              <button type="button" className={BTN_DANGER} onClick={() => setPendingDelete(true)}>
                Delete
              </button>
            </div>
          )}
        </div>

        {deleteError && (
          <p className="mb-[18px] text-[13.5px] text-[#c0574d]">Could not delete the mission.</p>
        )}

        {/* status timeline */}
        <div
          className={cn(
            CARD,
            "mb-5 flex min-w-0 items-center overflow-x-auto px-5 py-4 whitespace-nowrap",
          )}
        >
          {timelineSteps(mission.status).map((step) => (
            <div key={step.status} className="flex items-center">
              <span
                aria-hidden="true"
                className="box-border h-3 w-3 shrink-0 rounded-full border-2"
                style={{
                  borderColor: step.reached ? step.color : "#cbd5df",
                  background: step.reached ? step.color : "#ffffff",
                  boxShadow: step.current ? `0 0 0 4px ${step.color}29` : "none",
                }}
              />
              <span
                className={cn(
                  "ml-[9px] font-mono text-[11px] tracking-[0.03em] whitespace-nowrap",
                  step.reached ? "text-foreground" : "text-[#9aa8b6]",
                )}
              >
                {step.label}
              </span>
              {!step.last && <span className="mx-2 h-0.5 w-[26px] shrink-0 bg-[#e2e8ef]" />}
            </div>
          ))}
        </div>

        {/*
          `.detail__grid` is `1fr 400px` in the source, the right column being
          the bids/ratings aside (Phases 3/6). With no aside to place yet, the
          main column keeps the width that grid gives it — 1240 − 48 padding −
          400 aside − 20 gap — so the map renders at the size the design
          intends instead of stretching across the whole page. The grid itself
          returns when the aside does.
        */}
        <div className="grid items-start gap-5">
          <div className="max-w-[772px]">
            <div className="aspect-[1000/640] overflow-hidden rounded-xl border border-[#d3dbe3] bg-[#eef1ec] shadow-[0_1px_2px_rgba(20,35,55,0.05),0_12px_34px_rgba(20,35,55,0.1)]">
              {waypoints.length > 0 ? (
                <MissionMap waypoints={waypoints} geofence={mission.geofence} editable={false} />
              ) : (
                <div className="flex h-full items-center justify-center p-5 text-center text-[13.5px] text-[#93a1b0]">
                  No flight plan was saved for this mission.
                </div>
              )}
            </div>

            <div className="mt-3.5 grid grid-cols-3 gap-2.5">
              {[
                { label: "Waypoints", value: `${waypoints.length}` },
                { label: "Path length", value: distanceText(waypoints) },
                { label: "Est. flight", value: durationText(waypoints) },
              ].map((tile) => (
                <div key={tile.label} className={cn(CARD, "px-[13px] py-3 font-mono")}>
                  <div className={META_LABEL}>{tile.label}</div>
                  <div className="text-foreground mt-[5px] text-[15px]">{tile.value}</div>
                </div>
              ))}
            </div>

            <div className={cn(CARD, "mt-3.5 px-5 py-[18px]")}>
              <div className="mb-2.5 font-mono text-[10.5px] tracking-[0.1em] text-[#a2afbc]">
                BRIEF
              </div>
              <p className="mt-0 mb-4 text-sm leading-[1.6] break-words text-[#43525f]">
                {mission.description}
              </p>
              <div className="flex flex-wrap gap-[30px] font-mono">
                <div>
                  <div className={META_LABEL}>Flight window</div>
                  <div className="text-foreground mt-1 text-[13.5px]">{windowText(mission)}</div>
                </div>
                <div>
                  <div className={META_LABEL}>Bidding</div>
                  <div className="text-foreground mt-1 text-[13.5px]">{deadlineText(mission)}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <ConfirmDialog
        open={pendingDelete}
        title="Delete mission?"
        message={`“${mission.name}” will be permanently removed. This cannot be undone.`}
        confirmText="Delete mission"
        cancelText="Cancel"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(false)}
      />
    </>
  );
}
