import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Shared chrome for the public auth screens (`/login`, `/register`):
 * centered brand mark + a card the page content renders into. Mirrors the
 * `.auth`/`.auth__inner`/`.auth__brand`/`.auth__card` wrapper both
 * `login.component.html` and `register.component.html` repeat verbatim.
 *
 * SOURCE:
 * - drone-missions-frontend/.../components/login/login.component.html
 * - drone-missions-frontend/.../components/register/register.component.html
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <main
      className="flex min-h-screen items-center justify-center p-6"
      style={{
        // Mirrors `login.component.css`'s `:host` background exactly: blue
        // radial glow + 28px grid over the page gradient, canvas-sourced.
        backgroundImage:
          "radial-gradient(1100px 620px at 50% 18%, rgba(47, 107, 255, 0.10), transparent 68%)," +
          "linear-gradient(rgba(40, 70, 100, 0.045) 1px, transparent 1px)," +
          "linear-gradient(90deg, rgba(40, 70, 100, 0.045) 1px, transparent 1px)," +
          "linear-gradient(180deg, #f2f5f9, #e9edf2)",
        backgroundSize: "auto, 28px 28px, 28px 28px, auto",
        backgroundColor: "#eef1f5",
      }}
    >
      <div className="w-full max-w-sm space-y-6">
        <Link
          href="/"
          className="text-foreground flex items-center justify-center gap-2.5 font-mono text-sm font-semibold tracking-[0.18em]"
        >
          <span aria-hidden="true" className="bg-primary h-3 w-3 rotate-45" />
          DRONE MISSIONS
        </Link>
        <div className="border-border bg-card text-card-foreground rounded-2xl border p-7 shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}
