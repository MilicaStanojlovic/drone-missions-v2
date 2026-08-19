import type { Metadata } from "next";
import { AdminRegister } from "@/features/users/components/admin-register";

export const metadata: Metadata = {
  title: "New Admin — Drone Missions",
};

/**
 * `/admin/users/new` — create another administrator account. Mirrors
 * `{ path: 'admin/users/new', component: AdminRegisterComponent, canActivate:
 * [authGuard, adminGuard] }`, with both guards supplied by the layouts above.
 *
 * No `Suspense` boundary, unlike the list page: this form takes no query
 * parameters, so nothing below it reads `useSearchParams`.
 */
export default function AdminRegisterPage() {
  return <AdminRegister />;
}
