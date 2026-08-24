import type { Metadata } from "next";
import { AdminOverview } from "@/features/stats/components/admin-overview";

export const metadata: Metadata = {
  title: "Platform Overview — Drone Missions",
};

/**
 * `/admin/overview` — the admin's home, and the route `roleHomePath` has been
 * sending admins to since Phase 1. Mirrors
 * `{ path: 'admin/overview', component: AdminOverviewComponent,
 *    canActivate: [authGuard, adminGuard] }`; both guards are supplied by the
 * layouts above (`(app)/layout.tsx` and `(app)/admin/layout.tsx`), so the page
 * itself is just the component.
 *
 * No `Suspense` boundary: nothing below reads `useSearchParams` — the overview
 * takes no parameters, it is one snapshot call.
 */
export default function AdminOverviewPage() {
  return <AdminOverview />;
}
