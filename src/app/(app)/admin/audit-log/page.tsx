import { Suspense } from "react";
import type { Metadata } from "next";
import { AdminAuditLog } from "@/features/audit/components/admin-audit-log";

export const metadata: Metadata = {
  title: "Audit Log — Drone Missions",
};

/**
 * `/admin/audit-log` — every recorded action on the platform, newest first,
 * filterable by actor role, action and free text. Mirrors `{ path:
 * 'admin/audit-log', component: AdminAuditLogComponent, canActivate:
 * [authGuard, adminGuard] }`; both guards come from the layouts above
 * (`(app)/layout.tsx` and `(app)/admin/layout.tsx`), so the page itself is just
 * the component.
 *
 * The filters and page live in the query string (`?role&action&q&page`), so
 * `AdminAuditLog` reads `useSearchParams` — which needs a Suspense boundary
 * above it for Next to render this route's shell without waiting on the URL.
 */
export default function AdminAuditLogPage() {
  return (
    <Suspense>
      <AdminAuditLog />
    </Suspense>
  );
}
