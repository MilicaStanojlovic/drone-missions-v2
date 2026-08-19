import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Missions — Drone Missions",
};

/**
 * `/missions` — the PILOT role home (see `roleHomePath` in
 * `features/auth/auth.client.ts`). Placeholder only: this phase (Phase 1 —
 * Auth & current user) is limited to authentication and the `(app)` shell
 * itself, so there is nothing mission-related to render yet. Exists purely
 * so the `(app)` route group has a real page to mount for a PILOT visitor —
 * without one, Next never renders `(app)/layout.tsx` for this segment tree
 * at all, which would leave its auth guard, profile-chip fetch, and the
 * `Topbar`'s logout button unreachable by navigation and therefore
 * untestable end-to-end.
 *
 * Replaced with the real pilot mission browse/list view by the missions
 * phase (see `MIGRATION_PLAN.md`).
 */
export default function MissionsPage() {
  return (
    <div className="mx-auto max-w-[1240px] p-8">
      <h1 className="text-foreground text-xl font-semibold">Missions</h1>
      <p className="text-muted-foreground mt-2 text-sm">Coming soon.</p>
    </div>
  );
}
