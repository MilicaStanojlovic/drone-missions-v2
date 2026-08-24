import { Suspense } from "react";
import type { Metadata } from "next";
import { AdminUsers } from "@/features/users/components/admin-users";

export const metadata: Metadata = {
  title: "Users — Drone Missions",
};

/**
 * `/admin/users` — every account, paged and role-filterable, with
 * suspend/reactivate. Mirrors `{ path: 'admin/users', component:
 * AdminUsersComponent, canActivate: [authGuard, adminGuard] }`; both guards
 * come from the layouts above (`(app)/layout.tsx` and
 * `(app)/admin/layout.tsx`), so the page itself is just the component.
 *
 * The filter and page live in the query string (`?role&page`, plus the
 * `?created=` hand-off from the create form), so `AdminUsers` reads
 * `useSearchParams` — which needs a Suspense boundary above it for Next to
 * render this route's shell without waiting on the URL.
 */
export default function AdminUsersPage() {
  return (
    <Suspense>
      <AdminUsers />
    </Suspense>
  );
}
