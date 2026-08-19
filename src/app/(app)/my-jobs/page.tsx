import type { Metadata } from "next";
import { RequirePilot } from "@/features/auth/components/require-pilot";
import { MyJobsList } from "@/features/missions/components/my-jobs-list";

export const metadata: Metadata = {
  title: "My Jobs — Drone Missions",
};

/**
 * `/my-jobs` — the missions awarded to the signed-in pilot.
 *
 * There is no Angular route to mirror (the source never wired its
 * `getMyJobs()` up to a component), so this follows the shape of the one
 * pilot-only route that does exist, `{ path: 'my-bids', component:
 * MyBidsComponent, canActivate: [authGuard, pilotGuard] }`: `(app)/layout.tsx`
 * is the `authGuard` and `RequirePilot` the `pilotGuard`, matching the
 * backend's `@PreAuthorize("hasRole('PILOT')")` on
 * `GET /api/v1/missions/my-jobs` — which, unlike `/my-missions`, refuses a
 * designer outright rather than returning an empty list.
 *
 * No `Suspense` boundary here, unlike the feed pages: this list takes no query
 * parameters, so nothing below it reads `useSearchParams`.
 */
export default function MyJobsPage() {
  return (
    <RequirePilot>
      <MyJobsList />
    </RequirePilot>
  );
}
