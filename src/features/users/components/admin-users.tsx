"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Toast, useToast } from "@/components/toast";
import { serverMessage } from "@/lib/api/client";
import type { UserRole } from "@/db/schema";
import {
  USER_ROLE_COLORS,
  USER_ROLE_LABELS,
  fetchUsersPage,
  reactivateUser,
  suspendUser,
  type User,
} from "../user.client";

/**
 * Admin view: every account, paged and role-filterable, with suspend and
 * reactivate.
 *
 * A direct port of `AdminUsersComponent` — template, styles and behaviour.
 * What it preserves:
 *
 * - the four role segments (All / Designers / Pilots / Admins), seeded from
 *   `?role` with a *validated* value so a mangled deep link means "everyone";
 * - `?page` carried 1-based in the URL while the component (and the backend)
 *   count from 0;
 * - a filter change resets to page 0 and rewrites the query string wholesale
 *   with `replaceUrl: true` (which is what drops `page`), where a page step is
 *   a real history entry merged onto the existing params, so Back walks pages;
 * - suspend goes through the confirmation dialog with role-specific wording,
 *   reactivate does not;
 * - only the acting row's button is disabled (`acting === u.id`), and an ADMIN
 *   row offers no action at all;
 * - the server's own error message on a failed action, falling back to
 *   "Couldn't suspend X" / "Couldn't reactivate X".
 *
 * The Angular pieces with no counterpart here: the `FormControl` +
 * `valueChanges.pipe(distinctUntilChanged())` becomes `role` state plus the
 * equality guard in `setRole` (identical net behaviour — re-picking the active
 * segment does nothing), and the root-provided `ToastService` becomes the
 * local `useToast` hook, as everywhere else in this port.
 *
 * `?created=<username>` is read once on mount and turned into the green
 * "Admin created" toast: the create-admin form raises that message and then
 * navigates here, which in the source works because `<app-toast>` is mounted
 * once in `app.component.html` and survives the route change. Nothing here
 * outlives an unmount, so the message travels in the URL instead — the same
 * hand-off `register-form.tsx` → `login-form.tsx` already uses with
 * `?registered=1`.
 *
 * SOURCE: drone-missions-frontend/.../components/admin-users/admin-users.component.{ts,html,css}
 * DESIGN: design/DroneMissions.dc.html ("ADMIN — USERS" artboard)
 */

/** Angular's `| date: 'mediumDate'` ("Jun 15, 2015"). */
function mediumDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The role segments, in the source's order. `''` is "everyone". */
const SEGMENTS: { value: UserRole | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "DESIGNER", label: "Designers" },
  { value: "PILOT", label: "Pilots" },
  { value: "ADMIN", label: "Admins" },
];

/** `role && role in USER_ROLE_LABELS` — anything else means "everyone". */
function roleFromQuery(value: string | null): UserRole | "" {
  return value === "DESIGNER" || value === "PILOT" || value === "ADMIN" ? value : "";
}

/** Suspended red / active green — the status chip's accent. */
const SUSPENDED_COLOR = "#e04a3f";
const ACTIVE_COLOR = "#12a06a";

/** The table's five columns, shared by the header row and every body row. */
const ROW =
  "grid grid-cols-1 items-center gap-3.5 min-[641px]:grid-cols-[1fr_130px_120px_110px_120px]";

/** The chip shell; colour, background and border tint come from the accent. */
const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10.5px] tracking-[0.06em] uppercase";

/** A row's action button — outlined, tinted on hover, dimmed while acting. */
const MOD_BTN =
  "bg-card cursor-pointer rounded-[7px] border px-3 py-[7px] text-xs font-semibold transition-colors disabled:cursor-default disabled:opacity-55";

/** Tints a chip from one accent colour, as the source's three `[style.*]` bindings do. */
function chipStyle(color: string) {
  return { color, background: `${color}1a`, borderColor: `${color}55` };
}

export function AdminUsers() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, show } = useToast();

  // Seed from the URL, validating the role so a mangled deep link means
  // "everyone" and reading `?page` 1-based (`page=2` → index 1).
  const [role, setRoleState] = useState<UserRole | "">(() =>
    roleFromQuery(searchParams.get("role")),
  );
  /** 0-based, as the backend counts; the URL carries it 1-based. */
  const [pageIndex, setPageIndex] = useState(() => {
    const page = Number(searchParams.get("page"));
    return Number.isInteger(page) && page > 1 ? page - 1 : 0;
  });

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [totalPages, setTotalPages] = useState(0);
  const [totalElements, setTotalElements] = useState(0);

  /** The user a suspend confirmation is open for; null when the dialog is closed. */
  const [pending, setPending] = useState<User | null>(null);
  /** Id of the row whose action call is in flight, to disable its button. */
  const [acting, setActing] = useState<number | null>(null);

  // ---- load() ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchUsersPage({ role, page: pageIndex })
      .then((page) => {
        if (cancelled) {
          return;
        }
        setUsers(page.content);
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
  }, [role, pageIndex]);

  // ---- the `?created=` hand-off from /admin/users/new ----
  const greeted = useRef(false);
  useEffect(() => {
    const created = searchParams.get("created");
    if (!created || greeted.current) {
      return;
    }
    greeted.current = true;
    show(`Admin created — ${created}`, ACTIVE_COLOR);
    // Drop the parameter so a reload (or Back) does not replay the toast,
    // keeping whatever filter the URL already carried.
    const params = new URLSearchParams(searchParams.toString());
    params.delete("created");
    const query = params.toString();
    router.replace(`/admin/users${query ? `?${query}` : ""}`, { scroll: false });
  }, [searchParams, router, show]);

  /** Ports `setRole` + the `distinctUntilChanged` subscription behind it. */
  function setRole(next: UserRole | ""): void {
    if (next === role) {
      return;
    }
    setRoleState(next);
    setPageIndex(0);
    // syncUrl(): filter changes rewrite the query string wholesale, which also
    // drops `page`.
    router.replace(`/admin/users${next ? `?role=${next}` : ""}`, { scroll: false });
  }

  const lastPageIndex = Math.max(totalPages - 1, 0);

  /** Ports `goTo` — page steps are real history entries, merged onto `role`. */
  function goTo(index: number): void {
    setPageIndex(index);
    const params = new URLSearchParams();
    if (role) {
      params.set("role", role);
    }
    if (index !== 0) {
      params.set("page", String(index + 1));
    }
    const query = params.toString();
    router.push(`/admin/users${query ? `?${query}` : ""}`, { scroll: false });
  }

  /** Ports `replaceRow`. */
  const replaceRow = useCallback((updated: User) => {
    setUsers((current) => current.map((u) => (u.id === updated.id ? updated : u)));
  }, []);

  /** Ports `confirmSuspend`. */
  function confirmSuspend(): void {
    const user = pending;
    setPending(null);
    if (!user) {
      return;
    }
    setActing(user.id);
    suspendUser(user.id)
      .then((updated) => {
        replaceRow(updated);
        setActing(null);
        show(`${updated.username} suspended`, SUSPENDED_COLOR);
      })
      .catch((cause: unknown) => {
        console.error(cause);
        setActing(null);
        show(serverMessage(cause, `Couldn't suspend ${user.username}`), SUSPENDED_COLOR);
      });
  }

  /** Ports `reactivate` — no confirmation, lifting a suspension is not destructive. */
  function reactivate(user: User): void {
    setActing(user.id);
    reactivateUser(user.id)
      .then((updated) => {
        replaceRow(updated);
        setActing(null);
        show(`${updated.username} reactivated`, ACTIVE_COLOR);
      })
      .catch((cause: unknown) => {
        console.error(cause);
        setActing(null);
        show(serverMessage(cause, `Couldn't reactivate ${user.username}`), SUSPENDED_COLOR);
      });
  }

  /** Role-specific consequences, worded as in the design canvas. Ports `pendingBody`. */
  const pendingBody = !pending
    ? ""
    : pending.role === "PILOT"
      ? "This pilot will immediately be unable to place bids, be awarded missions, or execute jobs already awarded to them. Existing bids are kept."
      : "This designer will immediately be unable to create, edit, or publish missions, and their published missions will stop accepting bids.";

  /** Ports `pendingConfirmText`. */
  const pendingConfirmText = pending?.role === "PILOT" ? "Suspend pilot" : "Suspend designer";

  return (
    <section className="text-foreground mx-auto max-w-[1100px] px-[22px] pt-[34px] pb-[60px]">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-role-admin mb-1.5 font-mono text-[10.5px] tracking-[0.14em]">
            PLATFORM ADMIN
          </div>
          <h1 className="m-0 text-[28px] font-bold text-[#16222e]">Users</h1>
        </div>
        <Link
          href="/admin/users/new"
          className="bg-primary text-primary-foreground inline-flex items-center gap-[9px] rounded-[9px] px-[18px] py-[11px] text-sm font-semibold no-underline shadow-[0_4px_16px_rgba(47,107,255,0.28)] transition-colors hover:bg-[#1e5ae6]"
        >
          <span className="text-[17px] leading-none">+</span> New Admin
        </Link>
      </header>

      <div className="mb-[18px]">
        <div className="inline-flex rounded-[9px] border border-[#e2e8ef] bg-[#f0f3f7] p-[3px]">
          {SEGMENTS.map((segment) => (
            <button
              key={segment.value}
              type="button"
              className={cn(
                "cursor-pointer rounded-[7px] border-none px-4 py-2 text-[12.5px] font-medium text-[#5c6b7a]",
                role === segment.value
                  ? "bg-card font-semibold text-[#1b2732] shadow-[0_1px_3px_rgba(20,35,55,0.1)]"
                  : "bg-transparent",
              )}
              onClick={() => setRole(segment.value)}
            >
              {segment.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-muted-foreground py-10 text-center">Loading users…</p>
      ) : error ? (
        <p className="py-10 text-center text-[#c43a30]">
          {"Couldn't load users. Please try again."}
        </p>
      ) : users.length === 0 ? (
        <div className="rounded-[14px] border-[1.5px] border-dashed border-[#d3dbe3] px-5 py-14 text-center">
          <div className="text-lg font-semibold text-[#37475a]">
            {role ? "No users with this role." : "No accounts yet"}
          </div>
          <div className="mt-1.5 text-sm text-[#8494a5]">
            {role ? "Try another role filter." : "Registered users will appear here."}
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
              <span>User</span>
              <span>Role</span>
              <span>Status</span>
              <span>Joined</span>
              <span className="text-right">Action</span>
            </div>
            {users.map((user) => (
              <div
                key={user.id}
                className={cn(ROW, "border-b border-[#f2f5f8] px-[18px] py-3.5 last:border-b-0")}
              >
                <div className="min-w-0">
                  <div
                    className="truncate text-[13.5px] font-semibold text-[#1b2732]"
                    title={user.username}
                  >
                    {user.username}
                  </div>
                  <div
                    className="mt-[3px] truncate font-mono text-[10.5px] text-[#93a1b0]"
                    title={user.email}
                  >
                    {user.email}
                  </div>
                </div>
                <div>
                  <span className={CHIP} style={chipStyle(USER_ROLE_COLORS[user.role])}>
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: USER_ROLE_COLORS[user.role] }}
                    />
                    {USER_ROLE_LABELS[user.role]}
                  </span>
                </div>
                <div>
                  <span
                    className={CHIP}
                    style={chipStyle(user.suspended ? SUSPENDED_COLOR : ACTIVE_COLOR)}
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: user.suspended ? SUSPENDED_COLOR : ACTIVE_COLOR }}
                    />
                    {user.suspended ? "Suspended" : "Active"}
                  </span>
                </div>
                <div className="text-[12.5px] text-[#43525f]">{mediumDate(user.createdAt)}</div>
                <div className="min-[641px]:text-right">
                  {user.role === "ADMIN" ? (
                    <span className="text-[#b9c3cd]">—</span>
                  ) : user.suspended ? (
                    <button
                      type="button"
                      className={cn(
                        MOD_BTN,
                        "border-[#c9e8d9] text-[#12a06a] enabled:hover:border-[#9ed9bd] enabled:hover:bg-[#f0faf5]",
                      )}
                      disabled={acting === user.id}
                      onClick={() => reactivate(user)}
                    >
                      Reactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={cn(
                        MOD_BTN,
                        "border-[#f0d5d3] text-[#c0574d] enabled:hover:border-[#e5b0ab] enabled:hover:bg-[#fdf3f2]",
                      )}
                      disabled={acting === user.id}
                      onClick={() => setPending(user)}
                    >
                      Suspend
                    </button>
                  )}
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
              Page {pageIndex + 1} of {lastPageIndex + 1} · {totalElements} users
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
            Suspending a designer blocks new missions and freezes bidding on their existing ones.
            Suspending a pilot blocks bidding, awards, and execution of jobs already awarded to
            them.
          </div>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={`Suspend ${pending?.username ?? ""}?`}
        message={pendingBody}
        confirmText={pendingConfirmText}
        cancelText="No, keep it"
        danger
        onConfirm={confirmSuspend}
        onCancel={() => setPending(null)}
      />
      <Toast toast={toast} />
    </section>
  );
}
