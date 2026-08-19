import type { Metadata } from "next";
import { RequireDesigner } from "@/features/auth/components/require-designer";
import { MissionForm } from "@/features/missions/components/mission-form";

export const metadata: Metadata = {
  title: "New Mission — Drone Missions",
};

/**
 * `/missions/new` — the mission planner in its create flow. Mirrors the
 * Angular route `{ path: 'missions/new', component: MissionFormComponent,
 * canActivate: [authGuard, designerGuard] }`: `(app)/layout.tsx` is the
 * `authGuard`, `RequireDesigner` the `designerGuard`, and `MissionForm` with
 * no `missionId` is the component in the mode it takes when the route has no
 * `:id` segment.
 */
export default function NewMissionPage() {
  return (
    <RequireDesigner>
      <MissionForm />
    </RequireDesigner>
  );
}
