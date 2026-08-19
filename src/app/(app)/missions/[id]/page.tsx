import { Suspense } from "react";
import type { Metadata } from "next";
import { MissionDetail } from "@/features/missions/components/mission-detail";

export const metadata: Metadata = {
  title: "Mission — Drone Missions",
};

/**
 * `/missions/{id}` — one mission in full. Mirrors the Angular route `{ path:
 * 'missions/:id', component: MissionDetailComponent, canActivate: [authGuard] }`:
 * `(app)/layout.tsx` is the `authGuard`, and no role guard sits in front of it
 * — visibility is the API's call (`GET /api/v1/missions/{id}` 404s a mission
 * the caller may not see), exactly as in the source.
 *
 * The id is read from the route as `ngOnInit` reads it — `Number(...)` on the
 * raw segment, no validation of its own; a non-numeric segment fails the load
 * and the component shows its "Mission not found" state.
 *
 * `MissionDetail` reads the feed filters off the query string (so Back returns
 * to the marketplace as it was left), which needs a Suspense boundary above
 * `useSearchParams` for Next to render this route's shell without waiting on
 * the URL — the same boundary `(app)/missions/page.tsx` uses.
 */
export default async function MissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <MissionDetail missionId={Number(id)} />
    </Suspense>
  );
}
