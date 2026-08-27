"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, X } from "lucide-react";
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

/** The icon buttons on the right (bell, hamburger) share one shape. */
const ICON_BUTTON =
  "bg-card inline-flex h-[38px] w-[38px] items-center justify-center rounded-[9px] border transition-colors";

interface NavItem {
  href: string;
  label: string;
  /**
   * Match `pathname === href` instead of the default prefix match. Ports
   * `[routerLinkActiveOptions]="{ exact: true }"`, which the source sets on
   * exactly one link (see `ROLE_NAV.PILOT`'s Browse).
   */
  exact?: boolean;
}

/**
 * The topbar links per role, in the source's order — the `@if (auth.isDesigner)`
 * / `@if (auth.isPilot)` / `@if (auth.isAdmin)` blocks of `app.component.html`,
 * as data rather than three hand-written groups of `<Link>`s, since every entry
 * differs only in href and label. One table also means the desktop row and the
 * mobile drawer cannot drift apart.
 *
 * The admin group IS the admin section nav in both ground truths: no admin page
 * renders a nav of its own, so `(app)/admin/layout.tsx` deliberately adds none
 * (see its note). Wording follows the shipped header where it and the canvas
 * disagree ("Audit Log", not the canvas's "Audit log").
 */
const ROLE_NAV: Record<UserRole, readonly NavItem[]> = {
  DESIGNER: [
    { href: "/missions/mine", label: "My Missions" },
    { href: "/missions/new", label: "New Mission" },
  ],
  PILOT: [
    // `exact`, as the source marks it: every other mission route
    // (`/missions/mine`, `/missions/new`, `/missions/123`) is nested under
    // this href, so a prefix match would keep Browse lit across all of them.
    { href: "/missions", label: "Browse", exact: true },
    // Labelled "My Bids" after the shipped header, not the canvas's "My Bids
    // & Jobs": that mock is one button onto a tabbed list, and here the two
    // halves are two routes, so they are two links, side by side.
    { href: "/my-bids", label: "My Bids" },
    // Phase 5's `/my-jobs`. The source header has no such link (it never had
    // the page), so it takes the canvas's second half.
    { href: "/my-jobs", label: "My Jobs" },
  ],
  ADMIN: [
    { href: "/admin/overview", label: "Overview" },
    { href: "/admin/missions", label: "Missions" },
    { href: "/admin/users", label: "Users" },
    { href: "/admin/audit-log", label: "Audit Log" },
  ],
};

/** Roles that can hold notifications — the gate `notification.client.ts` applies. */
const NOTIFIED_ROLES: readonly UserRole[] = ["PILOT", "DESIGNER"];

const MOBILE_MENU_ID = "topbar-mobile-menu";

export interface TopbarProps {
  /** The signed-in user's display name, or null while the profile is still loading. */
  username: string | null;
  role: UserRole;
}

/**
 * Authenticated app shell topbar (replaces `AppComponent`'s `<header class="nav">`
 * and its `logout()` method): brand mark, the role's nav links, the
 * notification bell, the profile chip (the source's `nav__chip` link onto
 * `/profile`) and a logout button.
 *
 * Below `md` the nav links, chip and logout collapse into a drawer behind a
 * hamburger; the bell stays in the bar at every width so an unread badge is
 * never hidden behind a closed menu. Neither ground truth specifies this — the
 * canvas has no `@media` rule at all and the source has one (hiding the chip's
 * role label under 560px, `app.component.css:156-159`) which leaves an admin's
 * four links overflowing a phone. The drawer is built from the same hand-rolled
 * overlay pattern as `confirm-dialog.tsx` and the notification bell rather than
 * a `Sheet`, because `components/ui/` is empty and one drawer does not justify
 * pulling in `@radix-ui/react-dialog`.
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
  const [menuOpen, setMenuOpen] = useState(false);

  const navItems = ROLE_NAV[role];

  /**
   * Ports `routerLinkActive`: links are prefix matches unless they carry the
   * source's `exact` option — the prefix default is what keeps "Users" lit on
   * `/admin/users/new`.
   */
  const isActive = ({ href, exact }: NavItem) =>
    exact ? pathname === href : pathname.startsWith(href);

  // Close the drawer on navigation. Keyed on `pathname` rather than done in
  // each link's onClick so it also fires for a link onto the current route
  // (where Next renders no navigation at all) and for router pushes from
  // inside the drawer, like the bell's or logout's.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Escape closes the drawer — the same document listener, registered only
  // while open, that `confirm-dialog.tsx` uses for its own Escape handling.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  async function handleLogout() {
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      clearToken();
      router.push("/login");
    }
  }

  const profileChip = (
    <>
      <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", ROLE_DOT_CLASS[role])} />
      <span className="leading-tight">
        <span className="text-foreground block text-[12.5px] font-semibold">
          {username ?? "Account"}
        </span>
        <span className="text-muted-foreground block text-[9.5px] font-medium tracking-[0.08em] uppercase">
          {ROLE_LABEL[role]}
        </span>
      </span>
    </>
  );

  return (
    <header className="border-border bg-card sticky top-0 z-50 border-b">
      <div className="mx-auto flex h-[60px] max-w-[1240px] items-center justify-between gap-4 px-6">
        <div className="flex min-w-0 items-center gap-4 md:gap-[30px]">
          <Link
            href="/"
            className="text-foreground flex shrink-0 items-center gap-2.5 font-mono text-sm font-semibold tracking-[0.19em]"
          >
            <span aria-hidden="true" className="bg-primary h-[15px] w-[15px] rotate-45" />
            DRONEMISSIONS
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(NAV_LINK, isActive(item) ? NAV_LINK_ACTIVE : NAV_LINK_RESTING)}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2 md:gap-3.5">
          {/* Outside the drawer deliberately: the unread badge has to stay
              visible at every width. The role gate matches
              `canReceiveNotifications()` in `notification.client.ts` — pilots
              for the four source types, designers for this port's NEW_BID.
              An admin is the target of no notification, so gets no bell. */}
          {NOTIFIED_ROLES.includes(role) && <NotificationBell />}

          <div className="hidden items-center gap-3.5 md:flex">
            {/* The source's `nav__chip` — an anchor onto /profile (see CHIP). */}
            <Link
              href="/profile"
              title="View your profile"
              className={cn(CHIP, pathname.startsWith("/profile") ? CHIP_ACTIVE : CHIP_RESTING)}
            >
              {profileChip}
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="border-input text-muted-foreground hover:border-ring hover:text-foreground rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
            >
              Log out
            </button>
          </div>

          <button
            type="button"
            onClick={() => setMenuOpen((current) => !current)}
            aria-label="Menu"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls={MOBILE_MENU_ID}
            className={cn(
              ICON_BUTTON,
              "md:hidden",
              menuOpen
                ? "bg-accent border-[#cdd6df]"
                : "border-input hover:bg-accent hover:border-[#cdd6df]",
            )}
          >
            {menuOpen ? (
              <X aria-hidden="true" className="text-foreground h-[18px] w-[18px]" />
            ) : (
              <Menu aria-hidden="true" className="text-muted-foreground h-[18px] w-[18px]" />
            )}
          </button>
        </div>
      </div>

      {menuOpen && (
        <>
          {/* z-30 / z-40 here sit deliberately BELOW the notification bell's
              own backdrop (z-40) and panel (z-50), so the bell still opens
              over a drawer that is already down. Both are local to the
              header's stacking context, which its own z-50 creates. */}
          <div
            role="presentation"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-30 md:hidden"
          />
          <div
            id={MOBILE_MENU_ID}
            className="border-border bg-card animate-in fade-in slide-in-from-top-1 absolute inset-x-0 top-full z-40 border-b shadow-[0_12px_28px_rgba(20,35,55,0.12)] duration-150 ease-out md:hidden"
          >
            <nav className="flex flex-col py-2">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "px-6 py-3 text-sm font-medium no-underline transition-colors",
                    isActive(item)
                      ? "text-primary bg-[#eef3ff]"
                      : "text-[#5c6b7a] hover:bg-[#f0f3f7] hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="border-border flex items-center justify-between gap-4 border-t px-6 py-3">
              <Link href="/profile" title="View your profile" className={cn(CHIP, CHIP_RESTING)}>
                {profileChip}
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className="border-input text-muted-foreground hover:border-ring hover:text-foreground shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
              >
                Log out
              </button>
            </div>
          </div>
        </>
      )}
    </header>
  );
}
