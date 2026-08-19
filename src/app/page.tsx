"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getRole, isLoggedIn, roleHomePath } from "@/features/auth/auth.client";

/**
 * `/` (replaces `LandingComponent` + the `''` route's `landingGuard`). The
 * JWT lives in `localStorage`, so — unlike Angular's synchronous route
 * guard, which resolves before the component ever renders — this check can
 * only run client-side, after mount; nothing is rendered until it resolves,
 * so a logged-in visitor never sees the public landing page flash by.
 *
 * A logged-in visitor is sent straight to their role home; an anonymous one
 * sees the public landing content below. Mirrors `landingGuard` exactly,
 * including its fallback (anything that isn't ADMIN or DESIGNER lands on
 * the PILOT home).
 *
 * SOURCE: drone-missions-frontend/.../guards/auth.guard.ts (landingGuard)
 */
export default function Home() {
  const router = useRouter();
  const [showLanding, setShowLanding] = useState(false);

  useEffect(() => {
    if (isLoggedIn()) {
      router.replace(roleHomePath(getRole()));
    } else {
      setShowLanding(true);
    }
  }, [router]);

  if (!showLanding) {
    return null;
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Drone Missions</h1>
      <p className="text-muted-foreground max-w-md text-sm">
        A two-sided drone-mission marketplace. Under construction.
      </p>
    </main>
  );
}
