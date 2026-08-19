"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MissionCard } from "./mission-card";
import { MISSION_STATUS_COLORS, fetchMyJobs, type Mission } from "../mission.client";
import type { MissionStatus } from "../mission.types";

/**
 * The pilot's won work: every mission awarded to them, whatever stage it is at
 * — AWARDED (waiting to be started), IN_PROGRESS, COMPLETED, and the ones a
 * designer cancelled after awarding. Each card links to the mission detail,
 * which is where the job is actually started and marked finished.
 *
 * NO ANGULAR COUNTERPART: the source has `MissionService.getMyJobs()` and the
 * backend's `GET /api/v1/missions/my-jobs` behind it, but no component ever
 * calls it — there is no my-jobs route in `app.routes.ts` and no my-jobs
 * component in the repo. So this is composed from the ported pieces rather
 * than transcribed:
 * - the card grid is `MissionCard`, the same card the feed and the designer
 *   dashboard render (`mission-list.tsx`), which is also how the canvas draws
 *   this list — its pilot "My bids & jobs" tab is the open feed's grid with a
 *   different filter behind it;
 * - the page frame (eyebrow + title, the loading/error/empty-with-CTA body
 *   states, the "Browse missions" call to action on empty) follows
 *   `MyBidsList`, the other pilot-only list page, down to its strings;
 * - the status chips are `MISSION_STATUS_LABELS`/`MISSION_STATUS_COLORS`, the
 *   presentation consts the frontend guide names as the single source of
 *   truth for status display — never a hard-coded label or colour.
 *
 * The counts strip is the dashboard's stat tiles (`MissionList`'s `stats`)
 * with this list's three meaningful statuses; like there, it is computed from
 * the loaded missions rather than fetched, and hidden when the list is empty.
 *
 * Loading is the plain `load-on-mount` of `MyBidsList` rather than the feed's
 * debounced filter machinery: `/missions/my-jobs` takes no parameters, so
 * there is nothing to re-request. A pilot suspended after winning a job still
 * sees it here — the API keeps listing it, and only Start/Mark finished on the
 * detail page refuse (`UserSuspended`).
 *
 * SOURCE: drone-missions-frontend/.../services/mission.service.ts (`getMyJobs`)
 * DESIGN: design/DroneMissions.dc.html (pilot feed, "My bids & jobs" tab)
 */

/** The statuses a job passes through, in lifecycle order, for the counts strip. */
const JOB_STATUSES = [
  "AWARDED",
  "IN_PROGRESS",
  "COMPLETED",
] as const satisfies readonly MissionStatus[];

/** Labels for the counts strip — the tile wording, not the chips' status labels. */
const JOB_STATUS_TILE_LABELS: Record<(typeof JOB_STATUSES)[number], string> = {
  AWARDED: "To start",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
};

export function MyJobsList() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMyJobs()
      .then((loaded) => {
        if (!cancelled) {
          setMissions(loaded);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          console.error("Failed to load jobs", cause);
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
      <header className="mb-[26px] flex flex-wrap items-end justify-between gap-5">
        <div>
          <div className="text-role-pilot mb-2 font-mono text-[11px] tracking-[0.14em]">PILOT</div>
          <h1 className="m-0 text-[30px] font-bold tracking-[-0.01em] text-[#141e28]">My Jobs</h1>
        </div>
      </header>

      {!loading && !error && missions.length > 0 && (
        <div className="mb-[30px] grid grid-cols-3 gap-3">
          {JOB_STATUSES.map((status) => (
            <div
              key={status}
              className="bg-card rounded-xl border border-[#e8edf2] px-[18px] py-4 shadow-[0_1px_2px_rgba(20,35,55,0.04)]"
            >
              <div
                className="font-mono text-[28px] leading-none font-bold"
                style={{ color: MISSION_STATUS_COLORS[status] }}
              >
                {missions.filter((mission) => mission.status === status).length}
              </div>
              <div className="text-muted-foreground/80 mt-2 font-mono text-[11px] tracking-[0.08em] uppercase">
                {JOB_STATUS_TILE_LABELS[status]}
              </div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-muted-foreground py-10">Loading your jobs…</p>
      ) : error ? (
        <p className="py-10 text-[#c0574d]">{"Couldn't load your jobs. Please try again."}</p>
      ) : missions.length === 0 ? (
        <div className="rounded-[14px] border-[1.5px] border-dashed border-[#d3dbe3] px-5 py-14 text-center">
          <div className="text-lg font-semibold text-[#37475a]">No jobs yet</div>
          <div className="mt-1.5 text-sm text-[#8494a5]">
            Missions you win will show up here, ready to start.
          </div>
          <Link
            href="/missions"
            className="bg-role-pilot mt-4 inline-block rounded-[9px] px-[18px] py-2.5 text-[13.5px] font-semibold text-white no-underline"
          >
            Browse missions
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {missions.map((mission) => (
            <MissionCard
              key={mission.id}
              mission={mission}
              href={`/missions/${mission.id}?from=my-jobs`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
