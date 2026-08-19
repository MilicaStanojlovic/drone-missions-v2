import { Suspense } from "react";
import type { Metadata } from "next";
import { AdminMissions } from "@/features/missions/components/admin-missions";

export const metadata: Metadata = {
  title: "All Missions — Drone Missions",
};

/**
 * `/admin/missions` — every mission on the platform, searchable and paged,
 * with hide/unhide/remove moderation. Mirrors `{ path: 'admin/missions',
 * component: AdminMissionsComponent, canActivate: [authGuard, adminGuard] }`;
 * both guards come from the layouts above (`(app)/layout.tsx` and
 * `(app)/admin/layout.tsx`), so the page itself is just the component.
 *
 * The search and page live in the query string (`?q&page`), so
 * `AdminMissions` reads `useSearchParams` — which needs a Suspense boundary
 * above it for Next to render this route's shell without waiting on the URL.
 */
export default function AdminMissionsPage() {
  return (
    <Suspense>
      <AdminMissions />
    </Suspense>
  );
}
