"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { getRole } from "@/features/auth/auth.client";
import { RatingStars } from "@/features/ratings/components/rating-stars";
import { MissionMap } from "./mission-map";
import {
  MISSION_STATUS_COLORS,
  MISSION_STATUS_LABELS,
  fetchMyMissions,
  fetchOpenMissions,
  type Mission,
} from "../mission.client";
import { distanceText } from "../mission.geo";
import type { MissionStatus } from "../mission.types";

/**
 * Two experiences off one component, chosen by the `mine` prop:
 * - `mine` = true  → the designer dashboard (own missions + stat tiles).
 * - `mine` = false → the pilot feed / marketplace (open missions + filters).
 * Cards link to the mission detail; edit/delete live there. The pilot's bid
 * history lives on its own page (/my-bids).
 *
 * Ports `MissionListComponent` — template, styles and behaviour. Angular's
 * route `data: { mine: true }` flag becomes the prop, since App Router has no
 * route-data channel: `(app)/missions/page.tsx` and
 * `(app)/missions/mine/page.tsx` mount this component with the respective
 * value, exactly as the two Angular routes mount the one component.
 *
 * The reactive form + `valueChanges.pipe(debounceTime(300),
 * distinctUntilChanged(...))` becomes `filters` (what the inputs show) and
 * `applied` (what was last sent to the server), with a 300 ms timer between
 * them; `applied` keeps its identity when a change round-trips to the same
 * values, which is what makes the load effect fire exactly when the source's
 * subscription would. `router.navigate(..., { replaceUrl: true })` is
 * `router.replace`.
 *
 * SOURCE: drone-missions-frontend/.../components/mission-list/mission-list.component.{ts,html,css}
 */

interface FilterValues {
  keyword: string;
  location: string;
  date: string;
}

interface StatTile {
  label: string;
  value: number;
  color: string;
}

const NO_FILTERS: FilterValues = { keyword: "", location: "", date: "" };

/** `distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b))`, field by field. */
function sameFilters(a: FilterValues, b: FilterValues): boolean {
  return a.keyword === b.keyword && a.location === b.location && a.date === b.date;
}

/** The active filters as query params (empty values omitted). Ports `filterParams`. */
function filterParams(filters: FilterValues): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.keyword.trim()) {
    params.set("keyword", filters.keyword.trim());
  }
  if (filters.location.trim()) {
    params.set("location", filters.location.trim());
  }
  if (filters.date) {
    params.set("date", filters.date);
  }
  return params;
}

/** `?a=b` for a non-empty filter set, `""` otherwise — for building hrefs. */
function queryString(filters: FilterValues): string {
  const query = filterParams(filters).toString();
  return query ? `?${query}` : "";
}

/** Ports `hasActiveFilters`. */
function hasActiveFilters(filters: FilterValues): boolean {
  return !!(filters.keyword.trim() || filters.location.trim() || filters.date);
}

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

const FILTER_INPUT =
  "rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13.5px] text-foreground outline-none transition-colors focus:border-role-pilot";

export interface MissionListProps {
  /** true → the designer dashboard; false (default) → the open marketplace feed. */
  mine?: boolean;
}

export function MissionList({ mine = false }: MissionListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * Seed the filters from the URL so returning to the feed (e.g. from a
   * mission detail's Back button) restores whatever was applied. Done in the
   * initialiser — before the debounce effect can run — so it doesn't fire an
   * extra load, exactly as the source patches the form before subscribing.
   */
  const [filters, setFilters] = useState<FilterValues>(() =>
    mine
      ? NO_FILTERS
      : {
          keyword: searchParams.get("keyword") ?? "",
          location: searchParams.get("location") ?? "",
          date: searchParams.get("date") ?? "",
        },
  );
  /** The filters the current `missions` were loaded with (the debounced value). */
  const [applied, setApplied] = useState<FilterValues>(filters);

  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  /** Role drives the two header variants; it can only be read after mount (see `(app)/layout.tsx`). */
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => setRole(getRole()), []);

  // `valueChanges` never emits for the seeded values, so the first pass of
  // both effects below (the mount pass) is skipped.
  const skipDebounce = useRef(true);
  const skipUrlSync = useRef(true);

  // ---- debounceTime(300) + distinctUntilChanged ----
  useEffect(() => {
    if (mine) {
      return;
    }
    if (skipDebounce.current) {
      skipDebounce.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      setApplied((previous) => (sameFilters(previous, filters) ? previous : { ...filters }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filters, mine]);

  // ---- load() ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    const source = mine ? fetchMyMissions() : fetchOpenMissions(applied);
    source
      .then((loaded) => {
        if (!cancelled) {
          setMissions(loaded);
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
  }, [mine, applied]);

  // ---- syncUrl(): mirror the current filters into the feed URL ----
  useEffect(() => {
    if (mine) {
      return;
    }
    if (skipUrlSync.current) {
      skipUrlSync.current = false;
      return;
    }
    router.replace(`/missions${queryString(applied)}`, { scroll: false });
  }, [applied, mine, router]);

  const filtersActive = hasActiveFilters(filters);

  /** Dashboard stat tiles, computed client-side from the loaded missions. Ports `stats`. */
  const stats: StatTile[] = (() => {
    const count = (status: MissionStatus) => missions.filter((m) => m.status === status).length;
    return [
      { label: "Total", value: missions.length, color: "#2f6bff" },
      { label: "Draft", value: count("DRAFT"), color: MISSION_STATUS_COLORS.DRAFT },
      { label: "Published", value: count("PUBLISHED"), color: MISSION_STATUS_COLORS.PUBLISHED },
      { label: "Completed", value: count("COMPLETED"), color: MISSION_STATUS_COLORS.COMPLETED },
    ];
  })();

  function clearFilters(): void {
    setFilters(NO_FILTERS);
  }

  /** The query string carried onto a card's link, so the detail's Back returns to this feed. */
  const cardQuery = mine ? "" : queryString(filters);

  return (
    <section className="text-foreground mx-auto max-w-[1200px] px-6 pt-8 pb-[72px]">
      {mine ? (
        /* ===== Designer dashboard ===== */
        <>
          <header className="mb-[26px] flex flex-wrap items-end justify-between gap-5">
            <div>
              <div className="text-role-designer mb-2 font-mono text-[11px] tracking-[0.14em]">
                MISSION DESIGNER
              </div>
              <h1 className="m-0 text-[30px] font-bold tracking-[-0.01em] text-[#141e28]">
                My Missions
              </h1>
            </div>
            {role === "DESIGNER" && (
              <Link
                href="/missions/new"
                className="bg-primary text-primary-foreground inline-flex items-center gap-[9px] rounded-[9px] px-[18px] py-[11px] text-sm font-semibold no-underline shadow-[0_4px_16px_rgba(47,107,255,0.28)] transition-colors hover:bg-[#1e5ae6]"
              >
                <span className="text-[17px] leading-none">+</span> New Mission
              </Link>
            )}
          </header>

          {!loading && !error && missions.length > 0 && (
            <div className="mb-[30px] grid grid-cols-2 gap-3 min-[721px]:grid-cols-4">
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  className="bg-card rounded-xl border border-[#e8edf2] px-[18px] py-4 shadow-[0_1px_2px_rgba(20,35,55,0.04)]"
                >
                  <div
                    className="font-mono text-[28px] leading-none font-bold"
                    style={{ color: stat.color }}
                  >
                    {stat.value}
                  </div>
                  <div className="text-muted-foreground/80 mt-2 font-mono text-[11px] tracking-[0.08em] uppercase">
                    {stat.label}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        /* ===== Pilot feed / marketplace ===== */
        <>
          <header className="mb-[26px] flex flex-wrap items-end justify-between gap-5">
            <div>
              <div
                className={cn(
                  "mb-2 font-mono text-[11px] tracking-[0.14em]",
                  role === "PILOT" ? "text-role-pilot" : "text-[#93a1b0]",
                )}
              >
                {role === "PILOT" ? "PILOT" : "MARKETPLACE"}
              </div>
              <h1 className="m-0 text-[30px] font-bold tracking-[-0.01em] text-[#141e28]">
                Browse missions
              </h1>
            </div>
          </header>

          <div className="mb-[22px] flex flex-wrap items-center justify-between gap-4">
            <form
              className="flex flex-wrap items-center gap-2.5"
              onSubmit={(e) => e.preventDefault()}
            >
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 left-3 -translate-y-1/2 text-[13px] text-[#a2afbc]"
                >
                  ⚲
                </span>
                <input
                  type="text"
                  className={cn(FILTER_INPUT, "w-[220px] max-w-[60vw] pl-[34px]")}
                  value={filters.keyword}
                  onChange={(e) => setFilters((f) => ({ ...f, keyword: e.target.value }))}
                  placeholder="Search name or description…"
                />
              </div>
              <input
                type="text"
                className={FILTER_INPUT}
                value={filters.location}
                onChange={(e) => setFilters((f) => ({ ...f, location: e.target.value }))}
                placeholder="Location…"
                aria-label="Filter by location"
              />
              <input
                type="date"
                className={FILTER_INPUT}
                value={filters.date}
                onChange={(e) => setFilters((f) => ({ ...f, date: e.target.value }))}
                aria-label="Flyable on date"
              />
              {filtersActive && (
                <button
                  type="button"
                  className="border-input bg-accent cursor-pointer rounded-[9px] border px-[14px] py-[9px] text-[13px] text-[#4a5a6a] transition-colors hover:bg-[#e6ebf1]"
                  onClick={clearFilters}
                >
                  Clear
                </button>
              )}
            </form>
          </div>
        </>
      )}

      {/* ===== Body ===== */}
      {loading ? (
        <p className="text-muted-foreground py-10">Loading missions…</p>
      ) : error ? (
        <p className="py-10 text-[#c0574d]">{"Couldn't load missions. Please try again."}</p>
      ) : missions.length === 0 ? (
        <div className="bg-card rounded-[14px] border border-dashed border-[#cdd6df] px-5 py-[70px] text-center">
          <div className="mb-1.5 text-base text-[#5c6b7a]">
            {mine
              ? "No missions yet"
              : filtersActive
                ? "No missions match your filters"
                : "No open missions"}
          </div>
          <div className="text-[13.5px] text-[#93a1b0]">
            {mine
              ? "Create your first mission to start collecting bids."
              : filtersActive
                ? "Try adjusting or clearing your filters."
                : "Check back soon for published missions."}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {missions.map((mission) => (
            <Link
              key={mission.id}
              href={`/missions/${mission.id}${cardQuery}`}
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
                    <div className="text-[9.5px] tracking-[0.08em] text-[#a2afbc] uppercase">
                      Window
                    </div>
                    <div className="mt-[3px] text-[12.5px] text-[#43525f]">
                      {formatWindow(mission)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9.5px] tracking-[0.08em] text-[#a2afbc] uppercase">
                      Path
                    </div>
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
          ))}
        </div>
      )}
    </section>
  );
}
