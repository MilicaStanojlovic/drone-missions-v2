"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  MISSION_STATUSES,
  MISSION_STATUS_COLORS,
  MISSION_STATUS_LABELS,
} from "@/features/missions/mission.client";
import { fetchPlatformStats, type PlatformStats, type TopMission } from "../stats.client";

/**
 * Admin view: a platform-wide snapshot as stat tiles and simple bars — total
 * missions, active pilots, suspensions, bid count/volume/average, then
 * missions-by-status bars, a bids-per-mission column chart, and the
 * designer/pilot split of the user base.
 *
 * A direct port of `AdminOverviewComponent`: one `GET /api/v1/platform-stats`
 * on mount, three mutually exclusive body states (loading / error / stats),
 * and the same derived values (`totalMissions`, `bidVolumeText`, `avgBidText`,
 * `statusWidth`, `bidBarHeight`, `barLabel`, `roleShare`) computed on the
 * loaded snapshot rather than fetched. The Angular getters become plain
 * expressions here: they are pure functions of `stats`, which changes exactly
 * once, so there is nothing to memoize.
 *
 * NOTE — the endpoint behind this page is Phase 9's. `GET /platform-stats` is
 * the one admin endpoint Phase 7 does not port (MIGRATION_PLAN.md §7 puts it
 * in "Phase 9 — Platform stats dashboard", which depends on every data
 * vertical, ratings included). Until Phase 9 adds the route, the fetch 404s
 * and this renders the source's own error branch — the page, its guard, its
 * nav entry and its markup are in place, and Phase 9 has only a server side
 * left to build. Nothing here is stubbed against fabricated numbers: an admin
 * sees "couldn't load", never invented stats.
 *
 * Loading follows the repo's established shape (`my-jobs-list.tsx`): a
 * `cancelled` flag so a resolve after unmount cannot set state, and
 * `console.error` on the rejection exactly as the source's `error` handler
 * does before flipping its flag.
 *
 * SOURCE: drone-missions-frontend/.../components/admin-overview/admin-overview.component.{ts,html,css}
 * DESIGN: design/DroneMissions.dc.html ("ADMIN — OVERVIEW" artboard)
 */

/** The panel/tile chrome the canvas gives every card on this page. */
const CARD = "bg-card rounded-xl border border-[#e8edf2] shadow-[0_1px_2px_rgba(20,35,55,0.04)]";

/** A panel's small mono caption ("MISSIONS BY STATUS", …). */
const PANEL_TITLE = "mb-[18px] font-mono text-[10.5px] tracking-[0.1em] text-[#a2afbc]";

/** The right-aligned mono count shared by the status bars and the role rows. */
const BAR_COUNT = "text-right font-mono text-[12.5px] font-semibold text-[#1b2732]";

export function AdminOverview() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPlatformStats()
      .then((loaded) => {
        if (!cancelled) {
          setStats(loaded);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          console.error(cause);
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="text-foreground mx-auto max-w-[1200px] px-6 pt-8 pb-[72px]">
      <header className="mb-[26px]">
        <div className="text-role-admin mb-2 font-mono text-[11px] tracking-[0.14em]">
          PLATFORM ADMIN
        </div>
        <h1 className="m-0 text-[30px] font-bold tracking-[-0.01em] text-[#141e28]">
          Platform Overview
        </h1>
      </header>

      {loading ? (
        <p className="text-muted-foreground py-10 text-center">Loading stats…</p>
      ) : error ? (
        <p className="py-10 text-center text-[#c43a30]">
          Couldn&apos;t load the platform stats. Please try again.
        </p>
      ) : stats ? (
        <StatsBody stats={stats} />
      ) : null}
    </section>
  );
}

/**
 * The loaded snapshot. Split out so every derived value below can be a plain
 * `const` over a non-null `stats` — the `@else if (stats)` branch of the
 * template, where the source's getters stop needing their `?? {}` fallbacks.
 */
function StatsBody({ stats }: { stats: PlatformStats }) {
  /** Ports the `totalMissions` getter: the tiles' first number is a sum, not a field. */
  const totalMissions = Object.values(stats.missionsByStatus).reduce((a, b) => a + b, 0);

  /** Wording as in the design canvas: $ + thousands separators, no decimals. */
  const bidVolumeText = "$" + Math.round(stats.bidAmountTotal).toLocaleString("en-US");

  /**
   * Ports `avgBidText`, em dash and all — including its deliberate asymmetry
   * with `bidVolumeText`: the average is *not* run through `toLocaleString`.
   */
  const avgBidText =
    stats.bidCount === 0 ? "—" : "$" + Math.round(stats.bidAmountTotal / stats.bidCount);

  /** Bars are normalized to the largest bucket, not the total (canvas behavior). */
  const maxStatusCount = Math.max(1, ...Object.values(stats.missionsByStatus));
  const statusWidth = (count: number) => (count / maxStatusCount) * 100 + "%";

  const maxBids = Math.max(1, ...stats.topMissionsByBids.map((t) => t.bids));
  const bidBarHeight = (top: TopMission) => (top.bids / maxBids) * 100 + "%";

  /**
   * User-base bars are shares of ALL users, so the rows read as a split —
   * which is why the denominator counts admins even though only the designer
   * and pilot rows are drawn.
   */
  const totalUsers = Object.values(stats.usersByRole).reduce((a, b) => a + b, 0);
  const roleShare = (count: number) => (count / Math.max(1, totalUsers)) * 100 + "%";

  return (
    <>
      {/* Six tiles, each with its own accent colour. `repeat(6, 1fr)` down to
          3-up under 900px and 2-up under 640px, as the source CSS steps it. */}
      <div className="mb-5 grid grid-cols-2 gap-3 min-[640px]:grid-cols-3 min-[900px]:grid-cols-6">
        <Tile value={totalMissions} label="Total missions" />
        <Tile value={stats.activePilots} label="Active pilots" color="text-[#12a06a]" />
        <Tile value={stats.suspendedUsers} label="Suspended" color="text-[#e04a3f]" />
        <Tile value={stats.bidCount} label="Total bids" color="text-[#d9860a]" />
        <Tile value={bidVolumeText} label="Bid volume" color="text-[#7c5cff]" />
        <Tile value={avgBidText} label="Avg bid" color="text-[#0e9bb5]" />
      </div>

      <div className="grid gap-4 min-[900px]:grid-cols-2">
        <div className={cn(CARD, "p-5")}>
          <div className={PANEL_TITLE}>MISSIONS BY STATUS</div>
          <div className="flex flex-col gap-[11px]">
            {MISSION_STATUSES.map((status) => {
              const count = stats.missionsByStatus[status];
              return (
                <div key={status} className="grid grid-cols-[92px_1fr_28px] items-center gap-3">
                  <span className="font-mono text-[10.5px] tracking-[0.05em] text-[#5c6b7a] uppercase">
                    {MISSION_STATUS_LABELS[status]}
                  </span>
                  <div className="h-[9px] overflow-hidden rounded-[5px] bg-[#f2f5f8]">
                    {/* An empty bucket draws no fill at all, not a hairline —
                        the source's `@if (… > 0)` around the fill div. */}
                    {count > 0 && (
                      <div
                        className="h-full min-w-[3px] rounded-[4px] transition-[width] duration-300 ease-in-out"
                        style={{
                          width: statusWidth(count),
                          background: MISSION_STATUS_COLORS[status],
                        }}
                      />
                    )}
                  </div>
                  <span className={BAR_COUNT}>{count}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className={cn(CARD, "flex flex-col p-5")}>
          <div className={PANEL_TITLE}>BIDS PER MISSION</div>
          {stats.topMissionsByBids.length > 0 ? (
            <div className="flex min-h-[150px] flex-1 items-end gap-3">
              {stats.topMissionsByBids.map((top) => (
                <div
                  key={top.name}
                  className="flex h-full flex-1 flex-col items-center justify-end gap-[7px]"
                >
                  <span className="text-primary font-mono text-xs font-semibold">{top.bids}</span>
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className="min-h-[4px] w-full rounded-t-[5px] bg-[linear-gradient(180deg,#5b8cff,#2f6bff)] transition-[height] duration-300 ease-in-out"
                      style={{ height: bidBarHeight(top) }}
                    />
                  </div>
                  {/* `title` carries the full name the label truncates. */}
                  <span
                    title={top.name}
                    className="h-6 overflow-hidden text-center text-[9.5px] leading-[1.25] text-[#93a1b0]"
                  >
                    {barLabel(top.name)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-[#93a1b0]">
              No bids yet
            </div>
          )}
        </div>
      </div>

      <div className={cn(CARD, "mt-4 p-5")}>
        <div className={PANEL_TITLE}>USER BASE</div>
        <div className="flex flex-col gap-[13px]">
          <RoleRow
            label="Designers"
            count={stats.usersByRole.DESIGNER}
            width={roleShare(stats.usersByRole.DESIGNER)}
            fill="bg-role-designer"
          />
          <RoleRow
            label="Pilots"
            count={stats.usersByRole.PILOT}
            width={roleShare(stats.usersByRole.PILOT)}
            fill="bg-role-pilot"
          />
        </div>
      </div>
    </>
  );
}

/**
 * One stat tile. The number is mono and coloured per tile; the label is the
 * small uppercase mono caption underneath. `value` is a string for the two
 * money tiles and a number for the four counts, exactly as the template
 * interpolates them.
 */
function Tile({
  value,
  label,
  color = "text-[#1b2732]",
}: {
  value: number | string;
  label: string;
  color?: string;
}) {
  return (
    <div className={cn(CARD, "px-4 py-[15px]")}>
      <div className={cn("font-mono text-[23px] leading-[1.1] font-bold", color)}>{value}</div>
      <div className="mt-[7px] font-mono text-[10px] tracking-[0.08em] text-[#93a1b0] uppercase">
        {label}
      </div>
    </div>
  );
}

/** One row of the user-base split: label, share bar, count. */
function RoleRow({
  label,
  count,
  width,
  fill,
}: {
  label: string;
  count: number;
  width: string;
  fill: string;
}) {
  return (
    <div className="grid grid-cols-[96px_1fr_28px] items-center gap-3">
      <span className="text-[12.5px] text-[#43525f]">{label}</span>
      <div className="h-2 overflow-hidden rounded-[4px] bg-[#f2f5f8]">
        {count > 0 && <div className={cn("h-full rounded-[4px]", fill)} style={{ width }} />}
      </div>
      <span className={BAR_COUNT}>{count}</span>
    </div>
  );
}

/**
 * The column chart's x-axis label: the part of a mission name before its
 * em-dash subtitle, capped at 24 characters. Ports `barLabel` verbatim,
 * including the fact that the cap can cut mid-word — the full name is on the
 * element's `title`.
 */
function barLabel(name: string): string {
  return name.split(" — ")[0].slice(0, 24);
}
