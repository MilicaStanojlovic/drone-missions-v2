"use client";

import Link from "next/link";
import { RatingStars } from "@/features/ratings/components/rating-stars";
import { MissionMap } from "./mission-map";
import { MISSION_STATUS_COLORS, MISSION_STATUS_LABELS, type Mission } from "../mission.client";
import { distanceText } from "../mission.geo";

/**
 * One mission as a grid card: map thumbnail with the status chip over it, name,
 * location, the window/path telemetry pair, and the designer footer — the whole
 * card being the link to that mission's detail page.
 *
 * Ports the `<a class="card">` block of `MissionListComponent`'s template (and
 * its CSS), which the canvas draws identically in the designer dashboard, the
 * pilot's "Open missions" feed and its "My bids & jobs" tab — one card, three
 * lists. It lived inline in `mission-list.tsx` while that component was the
 * only list; Phase 5's `/my-jobs` is the second, and it renders the same card
 * from the same `Mission` shape, so the markup moved here rather than being
 * copied. The only thing the two callers differ on is `href` — each carries
 * its own `?from`/filter query so the detail's Back returns where the user
 * came from — so that is the prop.
 *
 * (This is not the cross-feature case `my-bids-list.tsx` reasons about when it
 * keeps its own `mediumDate`: both callers here are missions-feature list
 * components, already sharing this feature's client bundle.)
 *
 * SOURCE: drone-missions-frontend/.../components/mission-list/mission-list.component.{html,css}
 * DESIGN: design/DroneMissions.dc.html (the feed card)
 */

/** Path distance shown on a mission's card (— when it has no route). Ports `pathFor`. */
function pathFor(mission: Mission): string {
  const wps = mission.waypoints;
  return wps && wps.length > 1 ? distanceText(wps) : "—";
}

/** "Jul 18 – Jul 22" style flight window from the mission's start/end times. Ports `formatWindow`. */
function formatWindow(mission: Mission): string {
  const fmt = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
  if (!mission.startTime && !mission.endTime) {
    return "TBD";
  }
  return `${fmt(mission.startTime)} – ${fmt(mission.endTime)}`;
}

/** Angular's `| date: 'mediumDate'` ("Jun 15, 2015"). */
function mediumDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export interface MissionCardProps {
  mission: Mission;
  /** Where the card links — the detail route plus whatever query the list wants Back to replay. */
  href: string;
}

export function MissionCard({ mission, href }: MissionCardProps) {
  return (
    <Link
      href={href}
      className="bg-card group flex flex-col overflow-hidden rounded-[14px] border border-[#e8edf2] text-inherit no-underline shadow-[0_1px_2px_rgba(20,35,55,0.04)] transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-[#2f6bff] hover:shadow-[0_12px_28px_rgba(20,35,55,0.1)]"
    >
      <div className="relative aspect-[1000/640] border-b border-[#e8edf2] bg-[#eef1ec]">
        <MissionMap
          interactive={false}
          waypoints={mission.waypoints ?? []}
          geofence={mission.geofence ?? null}
          className="absolute inset-0"
        />
        <span
          className="absolute top-2.5 right-2.5 inline-flex items-center gap-1.5 rounded-[20px] border border-transparent px-2.5 py-1 font-mono text-[10px] font-semibold tracking-[0.1em] uppercase"
          style={{
            color: MISSION_STATUS_COLORS[mission.status],
            background: `${MISSION_STATUS_COLORS[mission.status]}1a`,
            borderColor: `${MISSION_STATUS_COLORS[mission.status]}55`,
          }}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: MISSION_STATUS_COLORS[mission.status] }}
          />
          {MISSION_STATUS_LABELS[mission.status]}
        </span>
      </div>
      <div className="flex flex-1 flex-col px-4 pt-[15px] pb-4">
        <div className="text-foreground mb-[5px] text-[15px] leading-[1.3] font-semibold">
          {mission.name}
        </div>
        {mission.location && (
          <div className="mb-3 font-mono text-xs text-[#6b7c8d]">{mission.location}</div>
        )}
        <div className="mb-3.5 flex gap-4 font-mono">
          <div>
            <div className="text-[9.5px] tracking-[0.08em] text-[#a2afbc] uppercase">Window</div>
            <div className="mt-[3px] text-[12.5px] text-[#43525f]">{formatWindow(mission)}</div>
          </div>
          <div>
            <div className="text-[9.5px] tracking-[0.08em] text-[#a2afbc] uppercase">Path</div>
            <div className="mt-[3px] text-[12.5px] text-[#43525f]">{pathFor(mission)}</div>
          </div>
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5 border-t border-[#eef2f6] pt-3 font-mono text-xs text-[#93a1b0]">
          {mission.designerName && (
            <>
              <span className="font-sans text-[12.5px] font-semibold text-[#3c4a58]">
                by {mission.designerName}
              </span>
              <RatingStars
                average={mission.designerRating ?? 0}
                count={mission.designerRatingCount ?? 0}
                showEmpty={false}
              />
            </>
          )}
          <span className="ml-auto">Created {mediumDate(mission.createdAt)}</span>
        </div>
      </div>
    </Link>
  );
}
