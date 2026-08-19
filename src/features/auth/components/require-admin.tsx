"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getRole, isLoggedIn } from "@/features/auth/auth.client";

/**
 * Route guard for the admin section (`/admin/*`). Ports `adminGuard`: a
 * logged-out visitor goes to `/login`, and a logged-in non-admin is bounced to
 * *their* home — `/missions/mine` for a designer, `/missions` for anyone else.
 * That two-way fallback is what sets this guard apart from its two siblings,
 * which each send every rejected caller to one fixed route; it happens to
 * agree with `roleHomePath` for the two roles it can see, but it is the
 * source's own ternary rather than a call into that map (which would send an
 * admin to `/admin/overview` — a branch this guard can never take, since an
 * admin is precisely who it lets through).
 *
 * Same shape and same reasoning as `RequireDesigner`/`RequirePilot`: Angular
 * resolves `CanActivateFn` before the routed component is constructed, whereas
 * the JWT here only exists in `localStorage`, so the check runs after mount
 * and nothing renders until it passes — a pilot never sees a frame of the
 * admin console.
 *
 * The role is advisory in both ports. Every endpoint behind these pages
 * enforces `@PreAuthorize("hasRole('ADMIN')")` server-side, so a non-admin who
 * reaches the markup anyway still gets a 403 from the API. Those guards are the
 * `requireRole(caller, "ADMIN")` calls in the *route handlers* —
 * `api/v1/users/route.ts`, `users/admins/route.ts`,
 * `users/[id]/{suspend,reactivate}/route.ts`, `missions/all/route.ts`,
 * `missions/[id]/{hide,unhide,remove}/route.ts` and `audit-log/route.ts` — not
 * in the services those handlers call: `user.service.ts`, `mission.service.ts`
 * and `audit.service.ts` each deliberately carry no role check, because the
 * source keeps the gate at the controller too.
 *
 * SOURCE: drone-missions-frontend/.../guards/auth.guard.ts (`adminGuard`)
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    const role = getRole();
    if (role !== "ADMIN") {
      router.replace(role === "DESIGNER" ? "/missions/mine" : "/missions");
      return;
    }
    setAllowed(true);
  }, [router]);

  return allowed ? <>{children}</> : null;
}
