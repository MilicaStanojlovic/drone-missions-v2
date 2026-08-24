import { Suspense } from "react";
import type { Metadata } from "next";
import { MissionList } from "@/features/missions/components/mission-list";

export const metadata: Metadata = {
  title: "Missions — Drone Missions",
};

/**
 * `/missions` — the open marketplace feed, and the PILOT role home (see
 * `roleHomePath` in `features/auth/auth.client.ts`). Mirrors the Angular
 * route `{ path: 'missions', component: MissionListComponent, canActivate:
 * [authGuard] }`: `(app)/layout.tsx` is the `authGuard`, and `MissionList`
 * without `mine` is the component in the mode that route's (absent) `data:
 * { mine: true }` flag leaves it in.
 *
 * The feed's filters live in the query string (`?keyword&location&date`), so
 * `MissionList` reads them with `useSearchParams` — which needs a Suspense
 * boundary above it for Next to render this route's shell without waiting on
 * the URL.
 */
export default function MissionsPage() {
  return (
    <Suspense>
      <MissionList />
    </Suspense>
  );
}
