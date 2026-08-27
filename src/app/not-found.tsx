"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getRole, isLoggedIn, roleHomePath } from "@/features/auth/auth.client";

/**
 * Where "go back" leads, per role.
 *
 * `roleHomePath()` is reused for the href of a signed-in visitor, but not for
 * the signed-out case: its fallback branch answers `/missions` for a null role
 * (mirroring `landingGuard`'s unconditional ternary), which is the pilot feed
 * and would bounce an anonymous visitor into the auth guard. A signed-out 404
 * therefore goes to the public landing page instead.
 */
const SIGNED_OUT = { href: "/", label: "Back to home" } as const;

const ROLE_LABEL = {
  DESIGNER: "Back to My Missions",
  PILOT: "Back to Browse",
  ADMIN: "Back to Overview",
} as const;

/**
 * A quadcopter, drawn in the same stroke idiom as the rest of the app's inline
 * SVG (1.8px `currentColor` strokes with round caps — see the bell in
 * `notification-bell.tsx`), with the sensor lights and camera iris picking up
 * `--primary` so it reads as this product's drone and not clip art.
 *
 * The bob, the counter-phase ground shadow and the rotor spin are the
 * `.drone-*` classes in `globals.css`, which stop under
 * `prefers-reduced-motion: reduce`.
 */
function Drone() {
  return (
    <svg
      viewBox="0 0 220 168"
      role="img"
      aria-label="A drone hovering with no flight plan"
      className="text-muted-foreground h-auto w-[240px] max-w-full sm:w-[300px]"
    >
      {/* Ground shadow — outside the bobbing group so it stays on the floor. */}
      <ellipse className="drone-shadow" cx="110" cy="156" rx="52" ry="6" fill="#1b2732" />

      <g className="drone-craft" fill="none" stroke="currentColor" strokeWidth="1.8">
        {/* Arms, body corner → rotor hub. */}
        <g strokeLinecap="round">
          <path d="M86 66 L40 46" />
          <path d="M134 66 L180 46" />
          <path d="M86 92 L40 112" />
          <path d="M134 92 L180 112" />
        </g>

        {/* Rotors: a light guard ring, a hub, and the spinning blade. */}
        {(
          [
            { cx: 40, cy: 46, reverse: false },
            { cx: 180, cy: 46, reverse: true },
            { cx: 40, cy: 112, reverse: true },
            { cx: 180, cy: 112, reverse: false },
          ] as const
        ).map(({ cx, cy, reverse }) => (
          <g key={`${cx}-${cy}`}>
            <circle cx={cx} cy={cy} r="27" stroke="currentColor" strokeOpacity="0.28" />
            <ellipse
              className={reverse ? "drone-rotor drone-rotor--reverse" : "drone-rotor"}
              cx={cx}
              cy={cy}
              rx="25"
              ry="4.5"
              fill="currentColor"
              fillOpacity="0.14"
              stroke="currentColor"
              strokeOpacity="0.5"
            />
            <circle cx={cx} cy={cy} r="3" fill="currentColor" stroke="none" />
          </g>
        ))}

        {/* Fuselage. */}
        <rect x="80" y="62" width="60" height="34" rx="11" />

        {/* Status lights on the body face. */}
        <g stroke="none">
          <rect x="93" y="74" width="7" height="7" rx="2" fill="var(--primary)" />
          <rect x="106" y="74" width="7" height="7" rx="2" fill="var(--primary)" fillOpacity="0.55" />
          <rect x="119" y="74" width="7" height="7" rx="2" fill="var(--primary)" fillOpacity="0.25" />
        </g>

        {/* Gimbal + camera, slung under the belly. */}
        <path d="M110 96 L110 104" strokeLinecap="round" />
        <circle cx="110" cy="114" r="10" />
        <circle cx="110" cy="114" r="4" fill="var(--primary)" stroke="none" />

        {/* Landing skids. */}
        <g strokeLinecap="round">
          <path d="M90 96 L84 122" />
          <path d="M130 96 L136 122" />
          <path d="M72 122 L96 122" />
          <path d="M124 122 L148 122" />
        </g>
      </g>
    </svg>
  );
}

/**
 * The app-wide 404 (`app/not-found.tsx`), which Next renders for every URL that
 * matches no route. Neither ground truth has one — the Angular app had no
 * wildcard route and the design canvas has no 404 artboard — so this is new
 * design work rather than a port, built from the vocabulary both establish:
 * the auth screens' backdrop, the landing page's mono eyebrow, and the app's
 * inline-SVG line art.
 *
 * It deliberately renders no topbar. A root `not-found` sits inside
 * `app/layout.tsx` only, never inside `(app)/layout.tsx`, which is correct
 * here — a 404 is reachable signed out, and the topbar needs a role.
 *
 * Client component for the same reason `app/page.tsx` is one: the JWT lives in
 * `localStorage`, so the caller's role is unknowable until after mount. The
 * signed-out destination renders first and is corrected in an effect, so the
 * page is never blank and never flashes a link the visitor cannot follow.
 */
export default function NotFound() {
  const [target, setTarget] = useState<{ href: string; label: string }>(SIGNED_OUT);

  useEffect(() => {
    if (!isLoggedIn()) {
      return;
    }
    const role = getRole();
    if (role === null) {
      return;
    }
    setTarget({ href: roleHomePath(role), label: ROLE_LABEL[role] });
  }, []);

  return (
    <main
      className="text-foreground flex min-h-screen flex-col items-center justify-center px-6 py-12"
      style={{
        // The same backdrop as `(marketing)/layout.tsx` — blue radial glow over
        // a 28px grid over the page gradient — so the 404 belongs to the same
        // world as /login and the landing page rather than inventing a look.
        backgroundImage:
          "radial-gradient(1100px 620px at 50% 18%, rgba(47, 107, 255, 0.10), transparent 68%)," +
          "linear-gradient(rgba(40, 70, 100, 0.045) 1px, transparent 1px)," +
          "linear-gradient(90deg, rgba(40, 70, 100, 0.045) 1px, transparent 1px)," +
          "linear-gradient(180deg, #f2f5f9, #e9edf2)",
        backgroundSize: "auto, 28px 28px, 28px 28px, auto",
        backgroundColor: "#eef1f5",
      }}
    >
      <Link
        href="/"
        className="text-foreground mb-10 flex items-center gap-2.5 font-mono text-sm font-semibold tracking-[0.18em]"
      >
        <span aria-hidden="true" className="bg-primary h-3 w-3 rotate-45" />
        DRONEMISSIONS
      </Link>

      <Drone />

      <div className="mt-8 max-w-md text-center">
        <div className="text-primary font-mono text-[11px] tracking-[0.14em] uppercase">
          Error 404
        </div>
        <h1 className="mt-2 text-[28px] leading-tight font-bold tracking-[-0.02em] text-[#141e28] sm:text-[34px]">
          This mission has no flight plan
        </h1>
        <p className="text-muted-foreground mx-auto mt-3 text-[15px] leading-relaxed text-balance">
          The page you&rsquo;re looking for isn&rsquo;t on the map. It may have been moved,
          cancelled, or never existed.
        </p>

        <Link
          href={target.href}
          className="bg-primary text-primary-foreground mt-7 inline-block rounded-lg px-5 py-2.5 text-sm font-semibold shadow-[0_3px_12px_rgba(47,107,255,0.28)] transition-colors hover:bg-[#1e5ae6]"
        >
          {target.label} &nbsp;&rarr;
        </Link>
      </div>
    </main>
  );
}
