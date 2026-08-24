import type { Metadata } from "next";
import { ProfileView } from "@/features/users/components/profile-view";

export const metadata: Metadata = {
  title: "My Profile — Drone Missions",
};

/**
 * `/profile` — the signed-in user's own account and reputation. Mirrors the
 * Angular route `{ path: 'profile', component: ProfileComponent, canActivate:
 * [authGuard] }`: `(app)/layout.tsx` is the `authGuard`, and there is no role
 * guard because both sides of the marketplace have a profile (the backend's
 * `GET /api/v1/users/me` and `GET /api/v1/ratings/user/{id}` are likewise
 * authenticated-only, not role-gated).
 *
 * No `Suspense` boundary: nothing below reads `useSearchParams`.
 *
 * Reached through the topbar's profile chip — the source's `nav__chip` link
 * (`app.component.html`) — or by URL directly.
 *
 * SOURCE: drone-missions-frontend/.../app.routes.ts (`profile`)
 */
export default function ProfilePage() {
  return <ProfileView />;
}
