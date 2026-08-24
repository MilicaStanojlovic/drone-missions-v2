"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { apiFetch, clearToken } from "@/features/auth/auth.client";
import { NotificationBell } from "@/features/notifications/components/notification-bell";
import type { UserRole } from "@/db/schema";

/** Human label for the role chip. Mirrors `AppComponent.roleLabel`. */
const ROLE_LABEL: Record<UserRole, string> = {
  DESIGNER: "Mission Designer",
  PILOT: "Pilot",
  ADMIN: "Platform Admin",
};

/**
 * Accent colour for the role chip dot (blue designer, green pilot, purple
 * admin). Mirrors `AppComponent.roleColor` / `USER_ROLE_COLORS`
 * (models/user.model.ts) via the canvas-sourced `--role-*` CSS vars in
 * globals.css, not the stock Tailwind palette.
 */
const ROLE_DOT_CLASS: Record<UserRole, string> = {
  DESIGNER: "bg-role-designer",
  PILOT: "bg-role-pilot",
  ADMIN: "bg-role-admin",
};

/**
 * One `nav__link`, in its resting and `nav__link--active` forms. The colours
 * are the canvas's (`design/DroneMissions.dc.html`, its topbar `<nav>`), which
 * the source CSS matches.
 */
const NAV_LINK =
  "rounded-[7px] px-3 py-[7px] text-[13px] font-medium no-underline transition-colors";
const NAV_LINK_RESTING = "text-[#5c6b7a] hover:bg-[#f0f3f7] hover:text-foreground";
const NAV_LINK_ACTIVE = "text-primary bg-[#eef3ff]";

/**
 * The account chip — the source's separate `nav__chip` rule, not `nav__link`:
 * a pill that swaps its BORDER colour when active, leaving background and text
 * alone. Hover colours are the source CSS's literals; the resting border keeps
 * this port's token.
 */
const CHIP =
  "bg-secondary/40 flex items-center gap-2 rounded-full border py-1 pr-3.5 pl-2.5 no-underline transition-colors";
const CHIP_RESTING = "border-border hover:border-[#c3ccd6] hover:bg-[#eef2f6]";
const CHIP_ACTIVE = "border-primary";

/**
 * The admin section nav, in the source's order. Kept as data rather than four
 * hand-written `<Link>`s because every entry differs only in href and label —
 * the four `@if (auth.isAdmin)` anchors of `app.component.html`.
 */
const ADMIN_NAV = [
  { href: "/admin/overview", label: "Overview" },
  { href: "/admin/missions", label: "Missions" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/audit-log", label: "Audit Log" },
] as const;

export interface TopbarProps {
  /** The signed-in user's display name, or null while the profile is still loading. */
  username: string | null;
  role: UserRole;
}

/**
 * Authenticated app shell topbar (replaces `AppComponent`'s `<header class="nav">`
 * and its `logout()` method): brand mark, profile chip (username + role — the
 * source's `nav__chip` link onto `/profile`), and a logout button, plus the
 * `nav__links` row. Each role-specific link is added
 * by the phase that introduces its route, so the row currently holds the
 * pilot's "My Bids" (Phase 3) and "My Jobs" (Phase 5) plus the admin section's
 * four links (Phase 7); "My Missions" / "New Mission" / "Browse" arrive with
 * their own phase.
 *
 * Unlike `AuthService.logout()` (which is purely local — clears the token,
 * nothing else), this calls the already-ported `POST /api/v1/auth/logout`
 * first: the source never wires that endpoint up to any client action, but
 * the plan calls for it here now that the endpoint exists, so the token
 * discard + redirect run in a `finally` regardless of the request's outcome.
 *
 * SOURCE: drone-missions-frontend/.../app.component.{ts,html,css}
 */
export function Topbar({ username, role }: TopbarProps) {
  const router = useRouter();
  const pathname = usePathname();

  /**
   * Ports `routerLinkActive`: none of the source's topbar links carry the
   * `exact` option, so every one of them is a prefix match — which is also
   * what keeps "Users" lit on `/admin/users/new`.
   */
  const isActive = (href: string) => pathname.startsWith(href);

  async function handleLogout() {
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      clearToken();
      router.push("/login");
    }
  }

  return (
    <header className="border-border bg-card sticky top-0 z-50 border-b">
      <div className="mx-auto flex h-[60px] max-w-[1240px] items-center justify-between gap-4 px-6">
        <div className="flex min-w-0 items-center gap-[30px]">
          <Link
            href="/"
            className="text-foreground flex shrink-0 items-center gap-2.5 font-mono text-sm font-semibold tracking-[0.19em]"
          >
            <span aria-hidden="true" className="bg-primary h-[15px] w-[15px] rotate-45" />
            DRONEMISSIONS
          </Link>

          <nav className="flex items-center gap-1">
            {/* Pilots only, exactly as the source's `@if (auth.isPilot)` gates
                it. Labelled "My Bids" after the shipped header, not the
                canvas's "My Bids & Jobs": the jobs half of that mock never
                existed in the app, and the route is the bid history alone. */}
            {role === "PILOT" && (
              <>
                <Link
                  href="/my-bids"
                  className={cn(
                    NAV_LINK,
                    isActive("/my-bids") ? NAV_LINK_ACTIVE : NAV_LINK_RESTING,
                  )}
                >
                  My Bids
                </Link>
                {/* Phase 5's `/my-jobs`. The source header has no such link
                    (it never had the page), so it takes the canvas's second
                    half — "My Bids & Jobs" there is one button onto a tabbed
                    list; here the two halves are two routes, so they are two
                    links, side by side and in that order. */}
                <Link
                  href="/my-jobs"
                  className={cn(
                    NAV_LINK,
                    isActive("/my-jobs") ? NAV_LINK_ACTIVE : NAV_LINK_RESTING,
                  )}
                >
                  My Jobs
                </Link>
              </>
            )}

            {/* Admins only, exactly as the source's `@if (auth.isAdmin)` gates
                it — the four `/admin/*` routes of `app.routes.ts`, in the
                order and with the wording `app.component.html` uses ("Audit
                Log", not the canvas's "Audit log"). This row IS the admin
                section nav in both ground truths: no admin page renders a nav
                of its own, so `(app)/admin/layout.tsx` deliberately adds none
                (see its note). */}
            {role === "ADMIN" &&
              ADMIN_NAV.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={cn(NAV_LINK, isActive(href) ? NAV_LINK_ACTIVE : NAV_LINK_RESTING)}
                >
                  {label}
                </Link>
              ))}
          </nav>
        </div>

        <div className="flex items-center gap-3.5">
          {/* Pilots only — the same `@if (auth.isPilot)` gate the source puts
              around `<app-notification-bell />` in `nav__account`, and in the
              same slot: immediately before the profile chip. Designers and
              admins are never notified, so they get no bell. */}
          {role === "PILOT" && <NotificationBell />}
          {/* The source's `nav__chip` — an anchor onto /profile (see CHIP). */}
          <Link
            href="/profile"
            title="View your profile"
            className={cn(CHIP, isActive("/profile") ? CHIP_ACTIVE : CHIP_RESTING)}
          >
            <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", ROLE_DOT_CLASS[role])} />
            <span className="leading-tight">
              <span className="text-foreground block text-[12.5px] font-semibold">
                {username ?? "Account"}
              </span>
              <span className="text-muted-foreground block text-[9.5px] font-medium tracking-[0.08em] uppercase">
                {ROLE_LABEL[role]}
              </span>
            </span>
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="border-input text-muted-foreground hover:border-ring hover:text-foreground rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
          >
            Log out
          </button>
        </div>
      </div>
    </header>
  );
}
