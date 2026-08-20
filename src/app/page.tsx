"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getRole, isLoggedIn, roleHomePath } from "@/features/auth/auth.client";
import {
  MISSION_LIFECYCLE,
  MISSION_STATUS_COLORS,
  MISSION_STATUS_LABELS,
} from "@/features/missions/mission.client";

/**
 * The two role cards, kept as data so the markup below stays one loop — the
 * Angular template repeats the same block twice with a `--designer` /
 * `--pilot` modifier swapping four accent colours and the copy.
 *
 * SOURCE: drone-missions-frontend/.../components/landing/landing.component.html
 */
const ROLE_CARDS = [
  {
    role: "DESIGNER",
    eyebrow: "ROLE 01",
    name: "Mission Designer",
    description:
      "Plot waypoints on the map, publish the job, review incoming bids and award it to one pilot.",
    cta: "Continue as Designer →",
    // `.role--designer` accents: #2f6bff on a #eaf0ff/#d3e0ff icon tile.
    hover:
      "hover:border-role-designer hover:shadow-[0_12px_34px_rgba(47,107,255,0.14)] hover:-translate-y-0.5",
    iconTile: "bg-[#eaf0ff] border-[#d3e0ff]",
    accent: "text-role-designer",
    // `.role__diamond` — a 12px square rotated 45°, outlined not filled.
    glyph: "h-3 w-3 rotate-45 border-2 border-role-designer",
  },
  {
    role: "PILOT",
    eyebrow: "ROLE 02",
    name: "Pilot",
    description:
      "Browse published missions, study the flight plan, place a bid, and fly the jobs you win.",
    cta: "Continue as Pilot →",
    // `.role--pilot` accents: #12a06a on a #e5f6ee/#c5ecda icon tile.
    hover:
      "hover:border-role-pilot hover:shadow-[0_12px_34px_rgba(18,160,106,0.14)] hover:-translate-y-0.5",
    iconTile: "bg-[#e5f6ee] border-[#c5ecda]",
    accent: "text-role-pilot",
    // `.role__circle` — 13px, so a touch larger than the diamond.
    glyph: "h-[13px] w-[13px] rounded-full border-2 border-role-pilot",
  },
] as const;

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
 * The two role cards link into the registration flow with the role
 * prefilled (`register-form.tsx` reads `?role=`), and the footer link goes
 * to sign-in — same destinations as the Angular `routerLink`s.
 *
 * SOURCE:
 * - drone-missions-frontend/.../guards/auth.guard.ts (landingGuard)
 * - drone-missions-frontend/.../components/landing/landing.component.{ts,html,css}
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
    <main
      className="text-foreground relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-12"
      // `.landing`'s page gradient; the grid and glow ride above it as their
      // own absolutely-positioned layers, exactly as in the Angular DOM.
      style={{ background: "linear-gradient(180deg, #f2f5f9, #e9edf2)" }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(40, 70, 100, 0.045) 1px, transparent 1px)," +
            "linear-gradient(90deg, rgba(40, 70, 100, 0.045) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1100px 620px at 50% 30%, rgba(47, 107, 255, 0.1), transparent 68%)",
        }}
      />

      {/* `.landing__inner`'s `landing-in` keyframes (fade + 10px rise over
          0.3s) become the equivalent `tw-animate-css` utilities, with the
          same `prefers-reduced-motion` opt-out the component CSS has. */}
      <div className="animate-in fade-in slide-in-from-bottom-[10px] relative w-full max-w-[780px] text-center duration-300 ease-[ease] motion-reduce:animate-none">
        <div className="mb-[22px] inline-flex items-center gap-3">
          <span
            aria-hidden="true"
            className="bg-primary h-[22px] w-[22px] rotate-45 shadow-[0_6px_18px_rgba(47,107,255,0.4)]"
          />
          <span className="font-mono text-base font-semibold tracking-[0.24em]">DRONEMISSIONS</span>
        </div>

        <h1 className="m-0 mb-4 text-[44px] leading-[1.08] font-bold tracking-[-0.02em] text-[#141e28] max-[620px]:text-[34px]">
          The marketplace for
          <br />
          drone flight missions
        </h1>
        <p className="mx-auto mt-0 mb-10 max-w-[560px] text-base leading-[1.55] text-[#5c6b7a]">
          Plan a mission on the map, publish it for bids, and award the job to a licensed pilot.
          Choose how you want to get started.
        </p>

        <div className="mx-auto grid max-w-[720px] grid-cols-2 gap-[18px] max-[620px]:grid-cols-1">
          {ROLE_CARDS.map((card) => (
            <Link
              key={card.role}
              href={`/register?role=${card.role}`}
              className={`border-border bg-card block rounded-2xl border px-6 py-[26px] text-left text-inherit no-underline shadow-[0_1px_2px_rgba(20,35,55,0.04),0_10px_30px_rgba(20,35,55,0.05)] transition-[border-color,transform,box-shadow] duration-150 ease-[ease] ${card.hover}`}
            >
              <div className="mb-4 flex items-center gap-[11px]">
                <span
                  aria-hidden="true"
                  className={`flex h-[38px] w-[38px] items-center justify-center rounded-[10px] border ${card.iconTile}`}
                >
                  <span className={card.glyph} />
                </span>
                <span className={`font-mono text-[10.5px] tracking-[0.14em] ${card.accent}`}>
                  {card.eyebrow}
                </span>
              </div>
              <div className="mb-2 text-xl font-semibold text-[#141e28]">{card.name}</div>
              <p className="m-0 mb-4 text-[13.5px] leading-[1.55] text-[#5c6b7a]">
                {card.description}
              </p>
              <span className={`font-mono text-xs tracking-[0.04em] ${card.accent}`}>
                {card.cta}
              </span>
            </Link>
          ))}
        </div>

        {/* The lifecycle chips: same `MISSION_LIFECYCLE` order and same
            label/colour maps the mission badges and timeline use, so the
            landing page cannot drift from the rest of the app. `CANCELLED`
            is absent by design — it is not a step on the happy path. */}
        <div className="mt-11 flex flex-wrap items-center justify-center gap-0">
          {MISSION_LIFECYCLE.map((status, index) => (
            <div key={status} className="flex items-center">
              <span className="text-muted-foreground inline-flex items-center gap-[7px] font-mono text-[10.5px] tracking-[0.06em]">
                <span
                  aria-hidden="true"
                  className="h-[7px] w-[7px] rounded-full"
                  style={{ background: MISSION_STATUS_COLORS[status] }}
                />
                {MISSION_STATUS_LABELS[status]}
              </span>
              {index < MISSION_LIFECYCLE.length - 1 && (
                <span aria-hidden="true" className="mx-3 text-[11px] text-[#c3ccd6]">
                  ›
                </span>
              )}
            </div>
          ))}
        </div>

        <p className="mt-8 text-[13.5px] text-[#5c6b7a]">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-primary font-medium no-underline hover:text-[#1e5ae6]"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
