import { Suspense } from "react";
import type { Metadata } from "next";
import { MissionList } from "@/features/missions/components/mission-list";

export const metadata: Metadata = {
  title: "My Missions — Drone Missions",
};

/**
 * `/missions/mine` — the designer dashboard (every mission the caller owns,
 * whatever its status) and the DESIGNER role home (see `roleHomePath` in
 * `features/auth/auth.client.ts`). Mirrors the Angular route `{ path:
 * 'missions/mine', component: MissionListComponent, canActivate: [authGuard],
 * data: { mine: true } }` — the same component as `/missions`, with the flag
 * that switches it to the dashboard.
 *
 * Only `authGuard` gates it in the source, not `designerGuard`: the dashboard
 * lists whatever `GET /api/v1/missions/my-missions` returns for the caller,
 * which is empty for a non-designer. The "New Mission" CTA is the only
 * designer-only part, and `MissionList` gates that on the role itself.
 */
export default function MyMissionsPage() {
  return (
    <Suspense>
      <MissionList mine />
    </Suspense>
  );
}
