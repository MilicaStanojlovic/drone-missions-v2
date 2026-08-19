"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getRole, isLoggedIn } from "@/features/auth/auth.client";

/**
 * Route guard for the designer-only pages. Ports `designerGuard`: a
 * logged-out visitor goes to `/login`, a logged-in non-designer is bounced to
 * the open marketplace (`/missions`) — the source's exact fallback, not the
 * role-home mapping `landingGuard` uses.
 *
 * Angular resolves `CanActivateFn` before the routed component is ever
 * constructed; here the JWT only exists in `localStorage`, so the check can
 * only run after mount (the same reasoning as `(app)/layout.tsx`'s auth
 * check). Nothing renders until it passes, so a pilot never sees a frame of
 * the mission editor.
 *
 * The role is advisory in both ports — the API enforces
 * `@PreAuthorize("hasRole('DESIGNER')")` on create/update/delete regardless of
 * what the browser lets someone open.
 *
 * SOURCE: drone-missions-frontend/.../guards/auth.guard.ts (`designerGuard`)
 */
export function RequireDesigner({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    if (getRole() !== "DESIGNER") {
      router.replace("/missions");
      return;
    }
    setAllowed(true);
  }, [router]);

  return allowed ? <>{children}</> : null;
}
