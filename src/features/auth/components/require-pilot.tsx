"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getRole, isLoggedIn } from "@/features/auth/auth.client";

/**
 * Route guard for the pilot-only pages (`/my-bids`). Ports `pilotGuard`: a
 * logged-out visitor goes to `/login`, a logged-in non-pilot is bounced to the
 * designer dashboard (`/missions/mine`) — the source's exact fallback, which
 * is NOT the role-home mapping (an admin lands there too, not on
 * `/admin/overview`).
 *
 * Same shape and same reasoning as `RequireDesigner`: Angular resolves
 * `CanActivateFn` before the routed component is constructed, whereas the JWT
 * here only exists in `localStorage`, so the check runs after mount and
 * nothing renders until it passes. The role is advisory in both ports — the
 * API enforces `@PreAuthorize("hasRole('PILOT')")` on `GET /api/v1/bids/my`
 * regardless of what the browser lets someone open.
 *
 * SOURCE: drone-missions-frontend/.../guards/auth.guard.ts (`pilotGuard`)
 */
export function RequirePilot({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    if (getRole() !== "PILOT") {
      router.replace("/missions/mine");
      return;
    }
    setAllowed(true);
  }, [router]);

  return allowed ? <>{children}</> : null;
}
