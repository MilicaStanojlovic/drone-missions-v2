"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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

export interface TopbarProps {
  /** The signed-in user's display name, or null while the profile is still loading. */
  username: string | null;
  role: UserRole;
}

/**
 * Authenticated app shell topbar (replaces `AppComponent`'s `<header class="nav">`
 * and its `logout()` method): brand mark, profile chip (username + role), and a
 * logout button. Role-specific nav links (My Missions, Browse, Admin section, …)
 * are added by the phases that introduce those routes — none exist in the app
 * yet, so the nav itself is empty for now.
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
        <Link
          href="/"
          className="text-foreground flex shrink-0 items-center gap-2.5 font-mono text-sm font-semibold tracking-[0.19em]"
        >
          <span aria-hidden="true" className="bg-primary h-[15px] w-[15px] rotate-45" />
          DRONEMISSIONS
        </Link>

        <div className="flex items-center gap-3.5">
          {/* Pilots only — the same `@if (auth.isPilot)` gate the source puts
              around `<app-notification-bell />` in `nav__account`, and in the
              same slot: immediately before the profile chip. Designers and
              admins are never notified, so they get no bell. */}
          {role === "PILOT" && <NotificationBell />}
          <span
            className="border-border bg-secondary/40 flex items-center gap-2 rounded-full border py-1 pr-3.5 pl-2.5"
            title="Your account"
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
          </span>
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
