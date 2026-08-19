"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import type { AuditAction, UserRole } from "@/db/schema";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_SENTENCES,
  AUDIT_ROLE_COLORS,
  AUDIT_ROLE_LABELS,
  AUDIT_ROLE_PILL,
  fetchAuditLogPage,
  type AuditLogEntry,
} from "../audit.client";

/**
 * Admin view: the platform audit log as a newest-first timeline feed, paged
 * and filtered server-side against `GET /api/v1/audit-log`.
 *
 * A direct port of `AdminAuditLogComponent` — template, styles and behaviour.
 * What it preserves:
 *
 * - the three filters (`role` segments, `action` select, free-text `q`) as one
 *   group: any change debounces 300 ms, de-duplicates against the last applied
 *   combination, resets to page 0 and reloads;
 * - `role` and `action` seeded from the URL only when they are *valid* members
 *   of their union, so a mangled deep link filters as "everything" instead of
 *   400ing on the server's enum conversion;
 * - `?page` carried 1-based in the URL while the component (and the backend)
 *   count from 0;
 * - a filter change rewrites the query string wholesale with
 *   `replaceUrl: true` (which is what drops `page`), where a page step is a
 *   real history entry merged onto the existing params, so Back walks pages;
 * - day-granularity relative times ("today" / "1 day ago" / "N days ago")
 *   computed from calendar-day boundaries, with the exact moment on hover;
 * - the empty state's two wordings, keyed on whether filters are active.
 *
 * The Angular pieces with no counterpart here: the `FormGroup` +
 * `valueChanges.pipe(debounceTime(300), distinctUntilChanged(JSON.stringify))`
 * becomes one `filters` state object plus the `applied` combination the loader
 * runs on, with the debounce timer and the field-wise equality guard
 * reproducing both operators — the same shape `admin-missions.tsx` uses for its
 * single search control.
 *
 * SOURCE: drone-missions-frontend/.../components/admin-audit-log/admin-audit-log.component.{ts,html,css}
 * DESIGN: design/DroneMissions.dc.html ("ADMIN — AUDIT LOG" artboard)
 */

/** The three filters as one value, the ported shape of the source's `FormGroup`. */
interface Filters {
  role: UserRole | "";
  action: AuditAction | "";
  q: string;
}

/** The role segments, in the source's order. `''` is "everyone". */
const SEGMENTS: { value: UserRole | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "DESIGNER", label: "Designers" },
  { value: "PILOT", label: "Pilots" },
  { value: "ADMIN", label: "Admins" },
];

/** `role && role in USER_ROLE_LABELS` — anything else means "every role". */
function roleFromQuery(value: string | null): UserRole | "" {
  return value === "DESIGNER" || value === "PILOT" || value === "ADMIN" ? value : "";
}

/** `action && action in AUDIT_ACTION_LABELS` — anything else means "every action". */
function actionFromQuery(value: string | null): AuditAction | "" {
  return value !== null && value in AUDIT_ACTION_LABELS ? (value as AuditAction) : "";
}

/** The source's `distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b))`. */
function sameFilters(a: Filters, b: Filters): boolean {
  return a.role === b.role && a.action === b.action && a.q === b.q;
}

/**
 * Day-granularity like the design canvas. Ports `daysAgo`: the difference is
 * taken between calendar-day *starts*, so "yesterday at 23:00" is 1 day ago
 * however few hours have actually passed, and anything today (or ahead of now,
 * hence the `<= 0`) reads "today".
 */
function daysAgo(iso: string): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000);
  if (days <= 0) {
    return "today";
  }
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Angular's `| date: 'medium'` ("Jun 15, 2015, 9:03:01 PM") — the hover title. */
function mediumDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

const CONTROL =
  "bg-card text-foreground rounded-[9px] border border-[#dbe2ea] px-3 py-2.5 text-[13.5px] outline-none transition-colors focus:border-[#6d5ef0]";

const PAGER_BTN =
  "bg-card cursor-pointer rounded-[7px] border border-[#dbe2ea] px-[13px] py-[7px] text-xs font-medium text-[#5c6b7a] transition-colors enabled:hover:border-[#c3ccd6] enabled:hover:text-[#1b2732] disabled:cursor-not-allowed disabled:opacity-50";

export function AdminAuditLog() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Seed from the URL, validating both unions so a mangled deep link means
  // "everything", and reading `?page` 1-based (`page=2` → index 1).
  const [filters, setFilters] = useState<Filters>(() => ({
    role: roleFromQuery(searchParams.get("role")),
    action: actionFromQuery(searchParams.get("action")),
    q: searchParams.get("q") ?? "",
  }));
  /**
   * The filter combination the current rows were loaded with — the debounced
   * value. The ref mirrors it so the debounce timer can apply
   * `distinctUntilChanged` without `applied` being a dependency that would
   * restart the timer.
   */
  const [applied, setApplied] = useState<Filters>(filters);
  const appliedRef = useRef(applied);
  /** 0-based, as the backend counts; the URL carries it 1-based. */
  const [pageIndex, setPageIndex] = useState(() => {
    const page = Number(searchParams.get("page"));
    return Number.isInteger(page) && page > 1 ? page - 1 : 0;
  });

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [totalPages, setTotalPages] = useState(0);
  const [totalElements, setTotalElements] = useState(0);

  // ---- debounceTime(300) + distinctUntilChanged, then load() + syncUrl() ----
  // `valueChanges` never emits for the patched-in seed values, so the mount
  // pass is skipped exactly as the source patches the form before subscribing.
  const skipDebounce = useRef(true);
  useEffect(() => {
    if (skipDebounce.current) {
      skipDebounce.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      if (sameFilters(filters, appliedRef.current)) {
        return;
      }
      appliedRef.current = filters;
      setApplied(filters);
      setPageIndex(0);
      // syncUrl(): a filter change rewrites the query string wholesale, which
      // is what drops `page`.
      router.replace(`/admin/audit-log${queryString(filters)}`, { scroll: false });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filters, router]);

  // ---- load() ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchAuditLogPage({ ...applied, page: pageIndex })
      .then((page) => {
        if (cancelled) {
          return;
        }
        setEntries(page.content);
        // `this.pageIndex = page.page.number` — the server echoes the index it
        // served, so this is a no-op in practice (see `toPagedModel`) and
        // cannot loop this effect.
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

  /** Ports `hasActiveFilters` — read off the live form, not the applied one. */
  const hasActiveFilters = Boolean(filters.role || filters.action || filters.q.trim());

  const lastPageIndex = Math.max(totalPages - 1, 0);

  /** Ports `goTo` — page steps are real history entries, merged onto the filters. */
  function goTo(index: number): void {
    setPageIndex(index);
    router.push(`/admin/audit-log${queryString(applied, index)}`, { scroll: false });
  }

  // The page's `fadeup` keyframes become `tw-animate-css` utilities on the
  // section below — the same 0.25s fade + 8px rise, disabled under
  // `prefers-reduced-motion` as everywhere else in this port.
  return (
    <section className="text-foreground animate-in fade-in slide-in-from-bottom-2 mx-auto max-w-[900px] px-6 pt-8 pb-[72px] duration-[250ms] motion-reduce:animate-none">
      <header className="mb-[22px]">
        <div className="text-role-admin mb-2 font-mono text-[11px] tracking-[0.14em]">
          PLATFORM ADMIN
        </div>
        <h1 className="m-0 text-[30px] font-bold tracking-[-0.01em] text-[#141e28]">Audit Log</h1>
        <p className="mt-2 mb-0 text-[13.5px] text-[#5c6b7a]">
          Every designer, pilot, and admin action on the platform, newest first.
        </p>
      </header>

      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-5">
        <div className="inline-flex rounded-[9px] border border-[#e2e8ef] bg-[#f0f3f7] p-[3px]">
          {SEGMENTS.map((segment) => (
            <button
              key={segment.value}
              type="button"
              className={cn(
                "cursor-pointer rounded-[7px] border-none px-4 py-2 text-[12.5px] font-medium text-[#5c6b7a]",
                filters.role === segment.value
                  ? "bg-card font-semibold text-[#1b2732] shadow-[0_1px_3px_rgba(20,35,55,0.1)]"
                  : "bg-transparent",
              )}
              onClick={() => setFilters((current) => ({ ...current, role: segment.value }))}
            >
              {segment.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2.5">
          <select
            className={CONTROL}
            aria-label="Filter by action"
            value={filters.action}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                action: event.target.value as AuditAction | "",
              }))
            }
          >
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {AUDIT_ACTION_LABELS[action]}
              </option>
            ))}
          </select>
          <input
            type="text"
            className={cn(CONTROL, "w-[290px] max-w-full placeholder:text-[#9aa8b6]")}
            placeholder="Search by user or detail…"
            aria-label="Search by user or detail"
            value={filters.q}
            onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
          />
        </div>
      </div>

      {loading ? (
        <p className="text-muted-foreground py-10 text-center">Loading activity…</p>
      ) : error ? (
        <p className="py-10 text-center text-[#c43a30]">
          {"Couldn't load the audit log. Please try again."}
        </p>
      ) : (
        <>
          <div className="bg-card rounded-xl border border-[#e8edf2] px-5 py-1.5 shadow-[0_1px_2px_rgba(20,35,55,0.04)]">
            {entries.length === 0 ? (
              <div className="px-5 py-11 text-center text-[13.5px] text-[#93a1b0]">
                {hasActiveFilters ? "No actions match your filters." : "No actions recorded yet."}
              </div>
            ) : (
              entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex gap-3.5 border-b border-[#f2f5f8] py-3.5 last:border-b-0"
                >
                  <div
                    aria-hidden="true"
                    className="mt-[5px] h-[9px] w-[9px] shrink-0 rounded-full"
                    style={{ background: AUDIT_ROLE_COLORS[entry.actorRole] }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-[9px]">
                      <span className="text-[13.5px] font-semibold whitespace-nowrap text-[#1b2732]">
                        {entry.actorUsername}
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold tracking-[0.09em] whitespace-nowrap uppercase",
                          AUDIT_ROLE_PILL[entry.actorRole],
                        )}
                      >
                        {AUDIT_ROLE_LABELS[entry.actorRole]}
                      </span>
                      <span className="text-[13.5px] text-[#43525f]">
                        {AUDIT_ACTION_SENTENCES[entry.action]}
                      </span>
                    </div>
                    <div
                      className="mt-1 font-mono text-[11px] text-[#93a1b0]"
                      title={mediumDateTime(entry.createdAt)}
                    >
                      {entry.details ? `${entry.details} · ` : ""}
                      {daysAgo(entry.createdAt)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {entries.length > 0 && (
            <div className="mt-4 flex items-center justify-center gap-4">
              <button
                type="button"
                className={PAGER_BTN}
                disabled={pageIndex === 0}
                onClick={() => goTo(pageIndex - 1)}
              >
                ‹ Prev
              </button>
              <span className="font-mono text-xs text-[#93a1b0]">
                Page {pageIndex + 1} of {lastPageIndex + 1} · {totalElements} entries
              </span>
              <button
                type="button"
                className={PAGER_BTN}
                disabled={pageIndex >= lastPageIndex}
                onClick={() => goTo(pageIndex + 1)}
              >
                Next ›
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The query string for a filter combination, optionally carrying a page. Ports
 * both `syncUrl` (blank filters omitted, `q` trimmed, no `page`) and the
 * `queryParamsHandling: 'merge'` half of `goTo`, which merges a 1-based `page`
 * onto exactly those same filter params.
 */
function queryString(filters: Filters, pageIndex = 0): string {
  const params = new URLSearchParams();
  if (filters.role) {
    params.set("role", filters.role);
  }
  if (filters.action) {
    params.set("action", filters.action);
  }
  if (filters.q.trim()) {
    params.set("q", filters.q.trim());
  }
  if (pageIndex !== 0) {
    params.set("page", String(pageIndex + 1));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
