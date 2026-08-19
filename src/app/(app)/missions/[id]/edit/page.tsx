import type { Metadata } from "next";
import { RequireDesigner } from "@/features/auth/components/require-designer";
import { MissionForm } from "@/features/missions/components/mission-form";

export const metadata: Metadata = {
  title: "Edit Mission — Drone Missions",
};

/**
 * `/missions/{id}/edit` — the same planner, prefilled from an existing
 * mission. Mirrors the Angular route `{ path: 'missions/:id/edit', component:
 * MissionFormComponent, canActivate: [authGuard, designerGuard] }`.
 *
 * The id is read from the route exactly as `ngOnInit` reads it — `Number(...)`
 * on the raw segment, no validation of its own. A segment that is not a number
 * fails the load (the API rejects it) and the form shows its "Mission not
 * found" state, which is the source's behaviour for an unloadable mission.
 *
 * Ownership is the server's call, not this page's: `GET /api/v1/missions/{id}`
 * 404s a mission the caller may not see, and `PUT` 403s someone else's, so a
 * designer who opens another designer's mission gets the same outcome here as
 * in the Angular app.
 */
export default async function EditMissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequireDesigner>
      <MissionForm missionId={Number(id)} />
    </RequireDesigner>
  );
}
