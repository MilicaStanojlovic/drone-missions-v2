"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, getRole, isLoggedIn } from "@/features/auth/auth.client";
import { Topbar } from "@/components/app-shell/topbar";
import type { UserRole } from "@/db/schema";
import type { UserResponse } from "@/features/users/user.types";

/**
 * Authenticated app shell (replaces `AppComponent`'s template wrapper +
 * `authGuard`). Every route under `(app)` requires a logged-in session;
 * anonymous visitors are sent to `/login`, mirroring `authGuard`.
 * Role-specific guards (`designerGuard`/`pilotGuard`/`adminGuard`) land with
 * the phases that introduce the routes they protect.
 *
 * The JWT lives in `localStorage`, so — unlike Angular's synchronous
 * `CanActivateFn`, which resolves before the route component ever renders —
 * this check can only run client-side, after mount. Nothing under `(app)`
 * renders until the check resolves, so an anonymous visitor never sees a
 * flash of authenticated content.
 *
 * On success this also fetches the caller's profile for the topbar's name
 * (mirrors `AppComponent.ngOnInit`'s `auth.loadProfile()` — repopulating the
 * cached profile after a reload, since only the token survives storage). The
 * role itself doesn't need a fetch: like `AuthService.role`, it's read
 * synchronously off the token's `role` claim.
 *
 * SOURCE:
 * - drone-missions-frontend/.../app.component.{ts,html,css}
 * - drone-missions-frontend/.../guards/auth.guard.ts (authGuard)
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [role, setRole] = useState<UserRole | null>(null);
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    const currentRole = getRole();
    if (!isLoggedIn() || !currentRole) {
      router.replace("/login");
      return;
    }
    setRole(currentRole);

    let cancelled = false;
    apiFetch("/api/v1/users/me")
      .then((response) => (response.ok ? (response.json() as Promise<UserResponse>) : null))
      .then((profile) => {
        if (!cancelled && profile) {
          setUsername(profile.username);
        }
      })
      .catch(() => {
        // Profile fetch failing (network error) just leaves the chip on its
        // "Account" fallback; apiFetch already handles a 401 by clearing
        // the token and redirecting to /login itself.
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!role) {
    return null;
  }

  return (
    <>
      <Topbar username={username} role={role} />
      <main>{children}</main>
    </>
  );
}
