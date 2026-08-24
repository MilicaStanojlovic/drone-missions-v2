import type { ReactNode } from "react";
import { RequireAdmin } from "@/features/auth/components/require-admin";

/**
 * The admin section shell. Every route under `/admin` is admin-only, so the
 * guard lives here once rather than on each page — the layout is the direct
 * counterpart of the `canActivate: [authGuard, adminGuard]` that `app.routes.ts`
 * repeats on all five admin routes. `(app)/layout.tsx` above already supplies
 * the `authGuard` half (and the topbar), leaving `RequireAdmin` to be the
 * `adminGuard`.
 *
 * This is a server component that renders a client guard, the same split
 * `(app)/my-jobs/page.tsx` uses with `RequirePilot`: the page's static parts
 * stay server-rendered while the token check — which can only read
 * `localStorage` — runs after mount.
 *
 * NO SECTION NAV HERE, deliberately (a plan-vs-source divergence, noted in
 * the phase report). The plan sketches "a layout … and section nav (Overview /
 * Missions / Users / Audit log)", but in both ground truths that nav is part
 * of the topbar, not of the admin pages: `app.component.html` renders the four
 * links inside `nav__links` under `@if (auth.isAdmin)`, and the canvas's
 * topbar does the same under `sc-if isAdmin`. None of the four admin
 * components (`admin-overview`, `admin-missions`, `admin-users`,
 * `admin-audit-log`) renders a nav of its own — each starts straight at its
 * `page__head`. Putting one here as well would give an admin two nav rows.
 * The links therefore go in `components/app-shell/topbar.tsx`, and this layout
 * is the guard alone.
 *
 * SOURCE:
 * - drone-missions-frontend/.../app.routes.ts (the `admin/*` routes)
 * - drone-missions-frontend/.../guards/auth.guard.ts (`adminGuard`)
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <RequireAdmin>{children}</RequireAdmin>;
}
