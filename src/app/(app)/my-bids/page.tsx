import type { Metadata } from "next";
import { RequirePilot } from "@/features/auth/components/require-pilot";
import { MyBidsList } from "@/features/bids/components/my-bids-list";

export const metadata: Metadata = {
  title: "My Bids — Drone Missions",
};

/**
 * `/my-bids` — the pilot's bid history. Mirrors the Angular route `{ path:
 * 'my-bids', component: MyBidsComponent, canActivate: [authGuard, pilotGuard] }`:
 * `(app)/layout.tsx` is the `authGuard` and `RequirePilot` the `pilotGuard`,
 * matching the backend's `@PreAuthorize("hasRole('PILOT')")` on
 * `GET /api/v1/bids/my`.
 */
export default function MyBidsPage() {
  return (
    <RequirePilot>
      <MyBidsList />
    </RequirePilot>
  );
}
