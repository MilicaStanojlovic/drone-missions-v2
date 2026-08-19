"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { serverMessage } from "@/lib/api/client";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Toast, useToast } from "@/components/toast";
import { getRole, getUserId } from "@/features/auth/auth.client";
import { fetchBidsForMission, type Bid } from "@/features/bids/bid.client";
import { BidsPanel } from "@/features/bids/components/bids-panel";
import { fetchRatingsForMission, type Rating } from "@/features/ratings/rating.client";
import { RatingForm } from "@/features/ratings/components/rating-form";
import { RatingNote } from "@/features/ratings/components/rating-note";
import { RatingStars } from "@/features/ratings/components/rating-stars";
import { MissionMap } from "./mission-map";
import {
  MISSION_LIFECYCLE,
  MISSION_STATUS_COLORS,
  MISSION_STATUS_LABELS,
  cancelMission,
  completeMission,
  deleteMission,
  fetchMission,
  startMission,
  type Mission,
} from "../mission.client";
import { distanceText, durationText } from "../mission.geo";
import type { MissionStatus } from "../mission.types";

/**
 * One mission in full: status badge and lifecycle timeline, a read-only render
 * of the flight plan, telemetry, the brief, and the designer behind it — plus
 * Edit / Cancel / Delete for the owning designer and Start / Mark finished for
 * the pilot who won it.
 *
 * Ports `MissionDetailComponent` — template, styles and behaviour. Phase 3
 * adds the bids aside (`BidsPanel`, which owns the pilot's form and the
 * designer's list), the bid telemetry tile, the `refresh()` that re-reads
 * mission + bids in place after a bid action, and the `from=my-bids` Back
 * target the phase-2 port left pending. Phase 5 adds `isOwner` as a prop of
 * that aside, which is what turns on the designer's Accept-bid flow inside it,
 * plus the mission's own lifecycle controls: the winning pilot's Start / Mark
 * finished block (`isWinner`, `canStart`) and the owning designer's Cancel
 * (`canCancel`), each behind the source's confirm dialog and toast.
 *
 * Both sets of controls only hide what the server would refuse anyway — the
 * service re-checks caller, ownership and status on every call — and every
 * outcome, success *or* failure, ends in `refresh()`, because the usual reason
 * a lifecycle call 409s is that the mission moved on since this page loaded,
 * and re-reading is what replaces the now-wrong button with the truth behind
 * the error message. Nothing here advances a mission on its own: a mission
 * whose `startTime` has passed still reads AWARDED until its pilot presses
 * Start (see `mission.service.ts`).
 *
 * The read-only status timeline IS ported: it is derived purely from
 * `mission.status`, which this phase's API already returns, and it is what
 * makes the status badge legible.
 *
 * Angular's `ngOnInit` + `route.paramMap.subscribe` becomes the load effect;
 * `auth.userId` / `auth.isDesigner` are read after mount because the JWT they
 * decode lives in `localStorage` (see `(app)/layout.tsx` for the same pattern).
 *
 * The source's `toast.show(...)` feedback is raised by whichever component owns
 * the action: the bids panel keeps its own `useToast` for the bid actions, and
 * this one has its own for the three lifecycle actions (`useToast` is a hook,
 * not the source's root-provided singleton, so each is independent — only one
 * of them can ever have a toast up, because only one of them acted). The rate
 * form is the exception that has to borrow this one: rating unmounts it, so a
 * toast it owned would not outlive the action that raised it. Delete keeps the
 * treatment the phase-2 port gave it: a failure surfaces inline, and a success
 * is announced by the navigation itself, exactly as the source navigates away.
 *
 * Phase 6 fills in the ratings panel the phase-5 note above left pending: the
 * `loadRatings` gate, the `isParticipant` / `canRate` / `myRating` /
 * `ratingOfMe` / `counterpartName` getters, and the third `<aside>` — the rate
 * form for whoever has not rated yet, then a `RatingNote` in each direction.
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

/**
 * The `.panel*` trio the ratings aside shares with the bids aside — same
 * classes `BidsPanel` carries, because in the source they are the same
 * `.panel` / `.panel__head` / `.panel__title` / `.panel__body` / `.panel__empty`
 * rules on both asides.
 */
const PANEL =
  "bg-card overflow-hidden rounded-xl border border-[#e8edf2] shadow-[0_1px_2px_rgba(20,35,55,0.04),0_8px_24px_rgba(20,35,55,0.05)]";
const PANEL_HEAD = "flex items-center justify-between border-b border-[#eef2f6] px-[18px] py-4";
const PANEL_TITLE = "text-foreground text-[15px] font-semibold";
const PANEL_BODY = "px-[18px] py-4";
const PANEL_EMPTY = "px-5 py-[34px] text-center text-[13.5px] text-[#93a1b0]";

/**
 * The winning pilot's lifecycle card at the top of the bids aside (`.finish`
 * and friends). Its blue is the canvas primary `#2f6bff` on the `#eef7ff` /
 * `#cfe6fb` wash the design system pairs with it, and the finished state
 * switches to the completed-green trio, exactly as the source's CSS does.
 */
const FINISH = "mb-3.5 rounded-[10px] border border-[#cfe6fb] bg-[#eef7ff] px-[15px] py-3.5";
const FINISH_DONE = "border-[#cbe9d8] bg-[#eef8f2]";
const FINISH_TITLE = "text-sm font-bold text-[#16222e]";
const FINISH_SUB = "mt-[5px] text-[12.5px] text-[#5c6b7a]";
const FINISH_CTA =
  "mt-3 w-full cursor-pointer rounded-lg bg-[#2f6bff] p-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-[#2357d6]";

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
  const [bids, setBids] = useState<Bid[]>([]);
  /** Both directions for this mission; empty until it completes. Ports `ratings`. */
  const [ratings, setRatings] = useState<Rating[]>([]);
  /**
   * Bumped by `onRated` to re-run the ratings read — the effect below has no
   * other input that changes when a rating is written, so this is what stands
   * in for the source calling `loadRatings(mission)` a second time by hand.
   */
  const [ratingsReload, setRatingsReload] = useState(0);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  /** The three lifecycle confirmations. Port `pendingStart` / `pendingComplete` / `pendingCancel`. */
  const [pendingStart, setPendingStart] = useState(false);
  const [pendingComplete, setPendingComplete] = useState(false);
  const [pendingCancel, setPendingCancel] = useState(false);
  const { toast, show } = useToast();

  /** Role and id come from the stored JWT, readable only after mount. */
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  useEffect(() => {
    setRole(getRole());
    setUserId(getUserId());
  }, []);

  /**
   * Ports `loadBids`. A failure is logged and left at that — the bids are a
   * panel on the page, not the page, so a designer whose bid list 500s still
   * gets the mission (the source makes the same call).
   */
  const loadBids = useCallback((id: number) => {
    fetchBidsForMission(id)
      .then(setBids)
      .catch((bidsError: unknown) => console.error("Failed to load bids", bidsError));
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
          loadBids(missionId);
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
  }, [missionId, loadBids]);

  /**
   * Re-fetch mission + bids in place (no full-page loading flash) after a bid
   * action — the mission because the first bid on it flips PUBLISHED to
   * BIDDING. Ports `refresh()`.
   */
  const refresh = useCallback(() => {
    fetchMission(missionId)
      .then(setMission)
      .catch((refreshError: unknown) => console.error("Failed to refresh mission", refreshError));
    loadBids(missionId);
  }, [missionId, loadBids]);

  const isPilot = role === "PILOT";
  /** Ports `isOwner`. A legacy ownerless mission (`userId: null`) has no owner. */
  const isOwner =
    role === "DESIGNER" && mission !== null && userId !== null && mission.userId === userId;
  /**
   * The calling pilot won this mission. Ports `isWinner` — with the same
   * `userId !== null` guard `isOwner` carries, so an unawarded mission
   * (`awardedPilotId: null`) read before the token is decoded is nobody's win.
   */
  const isWinner =
    isPilot && mission !== null && userId !== null && mission.awardedPilotId === userId;
  /** The awarded pilot can start their mission while it's still AWARDED. Ports `canStart`. */
  const canStart = isWinner && mission?.status === "AWARDED";
  /** The owning designer can cancel any mission that isn't finished yet. Ports `canCancel`. */
  const canCancel = isOwner && !["COMPLETED", "CANCELLED"].includes(mission?.status ?? "");

  // ---- ratings ----
  /** Either side of this mission — the same test the backend applies. Ports `isParticipant`. */
  const isParticipant =
    mission !== null &&
    userId !== null &&
    (mission.userId === userId || mission.awardedPilotId === userId);
  /**
   * Ports `loadRatings`'s gate: only participants may read a mission's ratings,
   * and only a completed mission has any, so anyone else would just collect a
   * 403.
   */
  const ratingsReadable = mission?.status === "COMPLETED" && isParticipant;

  /**
   * Ports `loadRatings`. The source calls it from `load()` with the mission it
   * just received; here it is an effect instead, because `isParticipant` needs
   * `userId`, which is decoded from the stored JWT in a mount effect and so is
   * not necessarily known yet when the mission arrives — an imperative call at
   * load time would read `null` and skip the fetch for good. Keying on
   * `ratingsReadable` re-runs it the moment either input becomes true, and
   * clears the list whenever it goes false (the source's `ratings = []` arm).
   *
   * A failure is logged and left at that, as the source does — the ratings are
   * a panel on the page, not the page.
   */
  useEffect(() => {
    if (!ratingsReadable) {
      setRatings([]);
      return;
    }
    let cancelled = false;
    fetchRatingsForMission(missionId)
      .then((loaded) => {
        if (!cancelled) {
          setRatings(loaded);
        }
      })
      .catch((ratingsError: unknown) => console.error("Failed to load ratings", ratingsError));
    return () => {
      cancelled = true;
    };
  }, [missionId, ratingsReadable, ratingsReload]);

  /** What the caller left, if they have rated. Ports `myRating`. */
  const myRating = ratings.find((rating) => rating.raterId === userId) ?? null;
  /** What the other side left about the caller. Ports `ratingOfMe`. */
  const ratingOfMe = ratings.find((rating) => rating.rateeId === userId) ?? null;
  /** A completed mission you took part in is rateable, once, by you. Ports `canRate`. */
  const canRate = ratingsReadable && !myRating;
  /** The accepted bid is where the winning pilot's name already lives. */
  const awardedPilotName = bids.find((bid) => bid.status === "ACCEPTED")?.pilotName;
  /**
   * Who the caller is rating: the designer sees the pilot, the pilot sees the
   * designer. Ports `counterpartName`.
   *
   * Still NOT ported here: the aside's "View {counterpartName}'s profile" link
   * (`mission-detail.component.html`, and the `counterpartId` getter behind
   * it). It routes to `/users/:id`, the public profile page that needs
   * `GET /users/{id}` — both of which `MIGRATION_PLAN.md` §Phase 7 owns and
   * `PLAN-ratings.md` fences off. Add the link, and `counterpartId` beside this
   * getter, when that endpoint lands.
   */
  const counterpartName = isOwner ? awardedPilotName : mission?.designerName;

  /** Where the user came from, so "Back" returns there (e.g. 'my-bids'). Ports `from`. */
  const from = searchParams.get("from") ?? "";

  /**
   * Ports `backLabel` / `back()`, plus one origin the source has no page for:
   * `from=my-jobs` is Phase 5's pilot jobs list (`/my-jobs`), which links its
   * cards the way `MyBidsList` links its rows. The source knows only
   * `my-bids`, so a mirror-only port would send a pilot arriving from their
   * jobs list "Back to feed" — a Back button that goes somewhere the user has
   * not been. Everything else is unchanged.
   */
  const backLabel =
    from === "my-bids"
      ? "Back to my bids"
      : from === "my-jobs"
        ? "Back to my jobs"
        : isPilot
          ? "Back to feed"
          : "My Missions";
  function back(): void {
    if (from === "my-bids" || from === "my-jobs") {
      router.push(`/${from}`);
      return;
    }
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

  /**
   * The three lifecycle confirmations. Each ports its `confirm*` handler
   * unchanged: close the dialog first so a second confirmation cannot re-fire
   * the call, then act, then `refresh()` — on the failure path too, since a
   * rejected call almost always means the mission is no longer in the state
   * the button assumed.
   */
  function confirmStart(): void {
    setPendingStart(false);
    if (!mission) {
      return;
    }
    startMission(mission.id)
      .then(() => {
        show("Mission started", "#2f6bff");
        refresh();
      })
      .catch((startError: unknown) => {
        console.error("Failed to start mission", startError);
        show(serverMessage(startError, "Could not start the mission"), "#e04a3f");
        refresh();
      });
  }

  function confirmComplete(): void {
    setPendingComplete(false);
    if (!mission) {
      return;
    }
    completeMission(mission.id)
      .then(() => {
        show("Mission marked as completed", "#12a06a");
        refresh();
      })
      .catch((completeError: unknown) => {
        console.error("Failed to complete mission", completeError);
        show(serverMessage(completeError, "Could not complete the mission"), "#e04a3f");
        refresh();
      });
  }

  function confirmCancel(): void {
    setPendingCancel(false);
    if (!mission) {
      return;
    }
    cancelMission(mission.id)
      .then(() => {
        show("Mission cancelled", "#e04a3f");
        refresh();
      })
      .catch((cancelError: unknown) => {
        console.error("Failed to cancel mission", cancelError);
        show(serverMessage(cancelError, "Could not cancel the mission"), "#e04a3f");
        refresh();
      });
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
              {canCancel && (
                <button type="button" className={BTN_SOFT} onClick={() => setPendingCancel(true)}>
                  Cancel mission
                </button>
              )}
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
          `.detail__grid` is a fixed `1fr 400px` in the source; the aside it
          sizes is now here (the ratings panel joins it in Phase 6). The two
          columns only split from `lg` up — below that 400px of aside beside
          the map is narrower than either wants — which is the one place this
          port improves on a source that has no breakpoint at all.
        */}
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0">
            <div className="aspect-[1000/640] overflow-hidden rounded-xl border border-[#d3dbe3] bg-[#eef1ec] shadow-[0_1px_2px_rgba(20,35,55,0.05),0_12px_34px_rgba(20,35,55,0.1)]">
              {waypoints.length > 0 ? (
                <MissionMap waypoints={waypoints} geofence={mission.geofence} editable={false} />
              ) : (
                <div className="flex h-full items-center justify-center p-5 text-center text-[13.5px] text-[#93a1b0]">
                  No flight plan was saved for this mission.
                </div>
              )}
            </div>

            <div className="mt-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {[
                { label: "Waypoints", value: `${waypoints.length}` },
                { label: "Path length", value: distanceText(waypoints) },
                { label: "Est. flight", value: durationText(waypoints) },
                { label: "Bids", value: `${bids.length}` },
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

          {/*
            Held back until the role is known. Unlike Angular's synchronous
            `auth.isPilot`, the role here is decoded from the stored JWT in a
            mount effect, so rendering the panel on the first pass would show
            a pilot the designer's "Bids" list for a frame before it swapped.
          */}
          {role !== null && (
            <BidsPanel
              mission={mission}
              bids={bids}
              isPilot={isPilot}
              isOwner={isOwner}
              onChanged={refresh}
              /*
                The winning pilot's lifecycle card. It sits at the top of the
                pilot's panel body in the source, above their own bid, but it
                is a *mission* control — its handlers, its confirmations and
                its copy (`windowText`) all belong to this component — so it is
                built here and handed to the panel as the slot it renders
                there, rather than duplicating mission state one level down.
                `isWinner` already implies the pilot branch, so the panel's
                designer face never receives it.
              */
              finishBlock={
                isWinner &&
                (mission.status === "IN_PROGRESS" ? (
                  <div className={FINISH}>
                    <div className={FINISH_TITLE}>Your mission is underway</div>
                    <div className={FINISH_SUB}>
                      Started {windowText(mission)} — let the designer know once it&apos;s done.
                    </div>
                    <button
                      type="button"
                      className={FINISH_CTA}
                      onClick={() => setPendingComplete(true)}
                    >
                      Mark mission finished
                    </button>
                  </div>
                ) : mission.status === "COMPLETED" ? (
                  <div className={cn(FINISH, FINISH_DONE)}>
                    <div className={FINISH_TITLE}>✓ Mission completed</div>
                    <div className={FINISH_SUB}>Thanks — you marked this mission as finished.</div>
                  </div>
                ) : (
                  canStart && (
                    <div className={FINISH}>
                      <div className={FINISH_TITLE}>You won this mission</div>
                      <div className={FINISH_SUB}>
                        Start it when you&apos;re ready to fly — then you can mark it finished.
                      </div>
                      <button
                        type="button"
                        className={FINISH_CTA}
                        onClick={() => setPendingStart(true)}
                      >
                        Start mission
                      </button>
                    </div>
                  )
                ))
              }
            />
          )}

          {/*
            The ratings panel — the same for both sides, so it sits outside the
            role branch the bids aside makes, exactly as the source's third
            `.detail__grid` child does. Auto-placement therefore lands it in
            column 1 of row 2 (under the brief) on a wide screen and in the
            single stack below `lg`, which is where the source puts it too.
          */}
          {ratingsReadable && mission && (
            <aside className={PANEL}>
              <div className={PANEL_HEAD}>
                <span className={PANEL_TITLE}>Rating</span>
              </div>
              <div className={PANEL_BODY}>
                {canRate && (
                  <RatingForm
                    missionId={mission.id}
                    counterpartName={counterpartName}
                    onRated={() => setRatingsReload((n) => n + 1)}
                    /*
                      The rate form raises its feedback through *this*
                      component's toast rather than one of its own, because
                      `onRated` re-reads the ratings and so unmounts the form:
                      a toast it owned would go with it after one GET instead
                      of the source's 2800 ms. In Angular the same message
                      survives because `ToastService` is root-provided and the
                      single `<app-toast>` sits in `app.component.html`.
                    */
                    show={show}
                  />
                )}

                {myRating && (
                  <RatingNote
                    rating={myRating}
                    label={`You rated ${counterpartName || "the other side"}`}
                  />
                )}

                {ratingOfMe ? (
                  <RatingNote
                    rating={ratingOfMe}
                    label={`${ratingOfMe.raterName} rated you`}
                    bordered
                  />
                ) : (
                  <div className={PANEL_EMPTY}>
                    {counterpartName || "The other side"} hasn’t rated you yet.
                  </div>
                )}
              </div>
            </aside>
          )}
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

      <ConfirmDialog
        open={pendingComplete}
        title="Mark mission finished?"
        message={`Confirm that “${mission.name}” has been completed. This moves it to Completed.`}
        confirmText="Yes, it's finished"
        cancelText="Not yet"
        onConfirm={confirmComplete}
        onCancel={() => setPendingComplete(false)}
      />

      <ConfirmDialog
        open={pendingStart}
        title="Start this mission?"
        message={`Mark “${mission.name}” as underway. This moves it to In Progress.`}
        confirmText="Start mission"
        cancelText="Not yet"
        onConfirm={confirmStart}
        onCancel={() => setPendingStart(false)}
      />

      <ConfirmDialog
        open={pendingCancel}
        title="Cancel this mission?"
        message={`“${mission.name}” will be cancelled and any outstanding bids rejected. This cannot be undone.`}
        confirmText="Cancel mission"
        cancelText="Keep it"
        danger
        onConfirm={confirmCancel}
        onCancel={() => setPendingCancel(false)}
      />

      <Toast toast={toast} />
    </>
  );
}
