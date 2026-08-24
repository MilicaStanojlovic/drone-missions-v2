"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Toast, useToast } from "@/components/toast";
import { serverMessage } from "@/lib/api/client";
import {
  MISSION_STATUS_COLORS,
  MISSION_STATUS_LABELS,
  fetchAllMissions,
  hideMission,
  removeMission,
  unhideMission,
  type Mission,
} from "../mission.client";

/**
 * Admin view: every mission on the platform, paged and searched server-side
 * against `GET /api/v1/missions/all`, with hide/unhide/remove moderation.
 *
 * A direct port of `AdminMissionsComponent` — template, styles and behaviour.
 * What it preserves:
 *
 * - the single `?q` search, debounced 300 ms and de-duplicated, matched
 *   server-side against mission name *or* designer;
 * - `?page` carried 1-based in the URL while the component (and the backend)
 *   count from 0;
 * - a search change resets to page 0 and rewrites the query string wholesale
 *   with `replaceUrl: true` (which is what drops `page`), where a page step is
 *   a real history entry merged onto the existing params, so Back walks pages;
 * - hide and remove confirm first, unhide fires directly — lifting a hide is
 *   reversible, so the source asks nothing;
 * - the two actions' different outcomes: hide/unhide *replace* the row with the
 *   `MissionResponse` the server returns, remove *drops* it and decrements the
 *   total, because that endpoint answers 204 with no body;
 * - only the acting row's two buttons are disabled (`acting === m.id`);
 * - the server's own error message on a failed action, falling back to
 *   "Couldn't hide/unhide/delete this mission".
 *
 * The Angular pieces with no counterpart here: the `FormControl` +
 * `valueChanges.pipe(debounceTime(300), distinctUntilChanged())` becomes the
 * `search` input state plus the `applied` value the loader actually runs on,
 * with the debounce timer and the equality guard reproducing both operators
 * (the same shape `mission-list.tsx` already uses for the feed filters), and
 * the root-provided `ToastService` becomes the local `useToast` hook.
 *
 * `mission-detail.tsx` is deliberately untouched: moderation lives on this
 * page in the source too — the detail view has no admin controls.
 *
 * SOURCE: drone-missions-frontend/.../components/admin-missions/admin-missions.component.{ts,html,css}
 * DESIGN: design/DroneMissions.dc.html ("ADMIN — MISSIONS" artboard)
 */

/** Angular's `formatDate(iso, 'MMM d', 'en-US')` ("Aug 12"). */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * "Novi Sad · Aug 12 – Aug 14", degrading gracefully when fields are unset.
 * Ports `meta`; the dash is the source's en dash, not a hyphen.
 */
function meta(mission: Mission): string {
  const parts: string[] = [mission.location?.trim() || "No location"];
  if (mission.startTime && mission.endTime) {
    parts.push(`${day(mission.startTime)} – ${day(mission.endTime)}`);
  }
  return parts.join(" · ");
}

/** The toast accents: amber for a hide/unhide, red for a delete or any failure. */
const WARN_COLOR = "#d9860a";
const DANGER_COLOR = "#e04a3f";

/** The table's four columns, shared by the header row and every body row. */
const ROW = "grid grid-cols-1 items-center gap-3.5 min-[641px]:grid-cols-[1fr_140px_120px_180px]";

/** A row's action button — outlined, tinted on hover, dimmed while acting. */
const MOD_BTN =
  "bg-card cursor-pointer rounded-[7px] border px-3 py-[7px] text-xs font-semibold transition-colors disabled:cursor-default disabled:opacity-55";

/** Tints the status chip from one accent colour, as the source's three `[style.*]` bindings do. */
function chipStyle(color: string) {
  return { color, background: `${color}1a`, borderColor: `${color}55` };
}

/** What a confirmation dialog is currently open for. Ports the `pending` field. */
type Pending = { mission: Mission; action: "hide" | "remove" };

export function AdminMissions() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, show } = useToast();

  // Seed from the URL so a deep link restores the search and page, reading
  // `?page` 1-based (`page=2` → index 1).
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  /**
   * The search the current rows were loaded with — the debounced value. The
   * ref mirrors it so the debounce timer can apply `distinctUntilChanged`
   * without `applied` being a dependency that would restart the timer.
   */
  const [applied, setApplied] = useState(search);
  const appliedRef = useRef(applied);
  /** 0-based, as the backend counts; the URL carries it 1-based. */
  const [pageIndex, setPageIndex] = useState(() => {
    const page = Number(searchParams.get("page"));
    return Number.isInteger(page) && page > 1 ? page - 1 : 0;
  });

  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [totalPages, setTotalPages] = useState(0);
  const [totalElements, setTotalElements] = useState(0);

  /** Mission a hide/remove confirmation is open for, and which action it is. */
  const [pending, setPending] = useState<Pending | null>(null);
  /** Id of the row whose action call is in flight, to disable its buttons. */
  const [acting, setActing] = useState<number | null>(null);

  // ---- debounceTime(300) + distinctUntilChanged, then load() + syncUrl() ----
  // `valueChanges` never emits for the seeded value, so the mount pass is
  // skipped exactly as the source patches the control before subscribing.
  const skipDebounce = useRef(true);
  useEffect(() => {
    if (skipDebounce.current) {
      skipDebounce.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      // `distinctUntilChanged()` compares raw control values, so typing and
      // un-typing within the debounce window emits nothing at all — no reload,
      // no page reset, no URL rewrite.
      if (search === appliedRef.current) {
        return;
      }
      appliedRef.current = search;
      setApplied(search);
      setPageIndex(0);
      // syncUrl(): a search change rewrites the query string wholesale, which
      // is what drops `page`.
      const trimmed = search.trim();
      router.replace(`/admin/missions${trimmed ? `?q=${encodeURIComponent(trimmed)}` : ""}`, {
        scroll: false,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, router]);

  // ---- load() ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchAllMissions({ q: applied, page: pageIndex })
      .then((page) => {
        if (cancelled) {
          return;
        }
        setMissions(page.content);
        // `this.pageIndex = page.page.number` — the server echoes the index it
        // served, so this is a no-op in practice (see `toPagedModel`) and
        // cannot loop this effect; it is kept because it is what makes the
        // pager honest if that ever stops being true.
        setPageIndex(page.page.number);
        setTotalPages(page.page.totalPages);
        setTotalElements(page.page.totalElements);
        setLoading(false);
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
  }, [applied, pageIndex]);

  const lastPageIndex = Math.max(totalPages - 1, 0);

  /** Ports `goTo` — page steps are real history entries, merged onto `q`. */
  function goTo(index: number): void {
    setPageIndex(index);
    const params = new URLSearchParams();
    if (applied.trim()) {
      params.set("q", applied.trim());
    }
    if (index !== 0) {
      params.set("page", String(index + 1));
    }
    const query = params.toString();
    router.push(`/admin/missions${query ? `?${query}` : ""}`, { scroll: false });
  }

  /** Ports `hideLabel`. */
  function hideLabel(mission: Mission): string {
    return mission.moderation === "HIDDEN" ? "Unhide" : "Hide";
  }

  /** Ports `onHideClick` — hide confirms first; unhide fires directly (reversible). */
  function onHideClick(mission: Mission): void {
    if (mission.moderation === "HIDDEN") {
      act(mission, "unhide");
    } else {
      setPending({ mission, action: "hide" });
    }
  }

  /** Ports `confirmPending`. */
  function confirmPending(): void {
    const current = pending;
    setPending(null);
    if (!current) {
      return;
    }
    if (current.action === "remove") {
      remove(current.mission);
    } else {
      act(current.mission, "hide");
    }
  }

  /**
   * Ports the private `removeMission`: permanent delete, so the row is dropped
   * rather than replaced — 204 comes back with nothing to replace it with.
   */
  function remove(mission: Mission): void {
    setActing(mission.id);
    removeMission(mission.id)
      .then(() => {
        setMissions((current) => current.filter((m) => m.id !== mission.id));
        setTotalElements((total) => Math.max(0, total - 1));
        setActing(null);
        show(`Deleted — ${(mission.name ?? "").slice(0, 34)}`, DANGER_COLOR);
      })
      .catch((cause: unknown) => {
        console.error(cause);
        setActing(null);
        show(serverMessage(cause, "Couldn't delete this mission"), DANGER_COLOR);
      });
  }

  /** Ports the private `act` + `actionLabel`. */
  function act(mission: Mission, action: "hide" | "unhide"): void {
    setActing(mission.id);
    const call = action === "hide" ? hideMission : unhideMission;
    call(mission.id)
      .then((updated) => {
        setMissions((current) => current.map((m) => (m.id === updated.id ? updated : m)));
        setActing(null);
        const label = action === "hide" ? "Hidden" : "Back in the feed";
        show(`${label} — ${(updated.name ?? "").slice(0, 34)}`, WARN_COLOR);
      })
      .catch((cause: unknown) => {
        console.error(cause);
        setActing(null);
        show(serverMessage(cause, `Couldn't ${action} this mission`), DANGER_COLOR);
      });
  }

  /** Ports `pendingTitle`. */
  const pendingTitle = pending?.action === "remove" ? "Delete this mission?" : "Hide this mission?";

  /** Consequence text per action, worded as in the design canvas. Ports `pendingBody`. */
  const pendingBody = !pending
    ? ""
    : pending.action === "remove"
      ? `“${pending.mission.name ?? ""}” will be permanently deleted, along with its bids and ratings. This cannot be undone.`
      : `“${pending.mission.name ?? ""}” will disappear from the pilot feed and stop receiving new bids. Its designer keeps it and can still see it.`;

  /** The empty state's two lines depend on whether a search produced it. */
  const searching = search.trim() !== "";

  return (
    <section className="text-foreground mx-auto max-w-[1100px] px-[22px] pt-[34px] pb-[60px]">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-5">
        <div>
          <div className="text-role-admin mb-1.5 font-mono text-[10.5px] tracking-[0.14em]">
            PLATFORM ADMIN
          </div>
          <h1 className="m-0 text-[28px] font-bold text-[#16222e]">All Missions</h1>
        </div>
        <input
          type="text"
          className="bg-card text-foreground w-[290px] max-w-full rounded-[9px] border border-[#dbe2ea] px-3 py-2.5 text-[13.5px] transition-colors outline-none focus:border-[#6d5ef0]"
          placeholder="Search by mission or designer…"
          aria-label="Search by mission or designer"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </header>

      {loading ? (
        <p className="text-muted-foreground py-10 text-center">Loading missions…</p>
      ) : error ? (
        <p className="py-10 text-center text-[#c43a30]">
          {"Couldn't load missions. Please try again."}
        </p>
      ) : missions.length === 0 ? (
        <div className="rounded-[14px] border-[1.5px] border-dashed border-[#d3dbe3] px-5 py-14 text-center">
          <div className="text-lg font-semibold text-[#37475a]">
            {searching ? "No missions match your search." : "No missions yet."}
          </div>
          <div className="mt-1.5 text-sm text-[#8494a5]">
            {searching
              ? "Try a different mission name or designer."
              : "Created missions will appear here."}
          </div>
        </div>
      ) : (
        <>
          <div className="bg-card overflow-hidden rounded-xl border border-[#e8edf2] shadow-[0_1px_2px_rgba(20,35,55,0.04)]">
            <div
              className={cn(
                ROW,
                "hidden border-b border-[#e8edf2] bg-[#f7f9fb] px-[18px] py-3 font-mono text-[9.5px] tracking-[0.09em] text-[#93a1b0] uppercase min-[641px]:grid",
              )}
            >
              <span>Mission</span>
              <span>Designer</span>
              <span>Status</span>
              <span className="text-right">Moderation</span>
            </div>
            {missions.map((mission) => (
              <div
                key={mission.id}
                className={cn(
                  ROW,
                  "border-b border-[#f2f5f8] px-[18px] py-3.5 last:border-b-0",
                  mission.moderation === "HIDDEN" && "opacity-75",
                )}
              >
                <div className="min-w-0">
                  <div
                    className="truncate text-[13.5px] leading-[1.35] font-semibold text-[#1b2732]"
                    title={mission.name ?? undefined}
                  >
                    {mission.name}
                  </div>
                  <div className="mt-1 truncate font-mono text-[10.5px] text-[#93a1b0]">
                    {meta(mission)}
                  </div>
                </div>
                <div
                  className="min-w-0 truncate text-[12.5px] text-[#43525f]"
                  title={mission.designerName ?? ""}
                >
                  {mission.designerName || "—"}
                  {mission.designerSuspended && (
                    <div className="mt-[3px] font-mono text-[9px] tracking-[0.08em] text-[#e04a3f] uppercase">
                      Suspended
                    </div>
                  )}
                </div>
                <div>
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10.5px] tracking-[0.06em] uppercase"
                    style={chipStyle(MISSION_STATUS_COLORS[mission.status])}
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: MISSION_STATUS_COLORS[mission.status] }}
                    />
                    {MISSION_STATUS_LABELS[mission.status]}
                  </span>
                </div>
                <div className="flex justify-start gap-[7px] min-[641px]:justify-end">
                  <button
                    type="button"
                    className={cn(
                      MOD_BTN,
                      "border-[#f2e0c4] text-[#a8720b] enabled:hover:border-[#e6c98f] enabled:hover:bg-[#fdf8ef]",
                    )}
                    disabled={acting === mission.id}
                    onClick={() => onHideClick(mission)}
                  >
                    {hideLabel(mission)}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      MOD_BTN,
                      "border-[#f0d5d3] text-[#c0574d] enabled:hover:border-[#e5b0ab] enabled:hover:bg-[#fdf3f2]",
                    )}
                    disabled={acting === mission.id}
                    onClick={() => setPending({ mission, action: "remove" })}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-center gap-4">
            <button
              type="button"
              className="bg-card cursor-pointer rounded-[7px] border border-[#dbe2ea] px-[13px] py-[7px] text-xs font-medium text-[#5c6b7a] transition-colors enabled:hover:border-[#c3ccd6] enabled:hover:text-[#1b2732] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={pageIndex === 0}
              onClick={() => goTo(pageIndex - 1)}
            >
              ‹ Prev
            </button>
            <span className="font-mono text-xs text-[#93a1b0]">
              Page {pageIndex + 1} of {lastPageIndex + 1} · {totalElements} missions
            </span>
            <button
              type="button"
              className="bg-card cursor-pointer rounded-[7px] border border-[#dbe2ea] px-[13px] py-[7px] text-xs font-medium text-[#5c6b7a] transition-colors enabled:hover:border-[#c3ccd6] enabled:hover:text-[#1b2732] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={pageIndex >= lastPageIndex}
              onClick={() => goTo(pageIndex + 1)}
            >
              Next ›
            </button>
          </div>

          <div className="mt-3 text-xs leading-[1.5] text-[#93a1b0]">
            Hidden missions stay with their designer but disappear from the pilot feed — reversible.
            Removing a mission permanently deletes it, along with its bids and ratings.
          </div>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pendingTitle}
        message={pendingBody}
        confirmText={pending?.action === "remove" ? "Delete mission" : "Hide mission"}
        cancelText="No, keep it"
        danger={pending?.action === "remove"}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />
      <Toast toast={toast} />
    </section>
  );
}
