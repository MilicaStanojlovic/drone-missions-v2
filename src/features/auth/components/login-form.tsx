"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { apiFetch, extractBearerToken, storeToken } from "@/features/auth/auth.client";

/**
 * The shared password of the seeded demo accounts below. One constant feeds
 * both the click handler and the caption, so the two cannot drift apart.
 */
const DEMO_PASSWORD = "Password123!";

/**
 * The seeded demo accounts offered under the form, one per role.
 *
 * Kept as data rather than two hand-written blocks because the rows differ
 * only in label, email and accent — the same shape `ROLE_NAV` uses in
 * `topbar.tsx` and `ROLE_CARDS` in `app/page.tsx`.
 *
 * The dots take the canvas-sourced `--role-*` tokens, the same accents the
 * topbar's profile chip uses, so a role reads the same colour app-wide.
 *
 * No counterpart in the source: the Angular login screen offers nothing like
 * this. It exists because the app is deployed publicly and registering gets
 * you a bare account with no missions, bids or history behind it — a visitor
 * would see an empty product.
 */
const DEMO_ACCOUNTS = [
  {
    label: "Mission Designer",
    email: "teodora.savic@dronehub.rs",
    dot: "bg-role-designer",
  },
  {
    label: "Pilot",
    email: "stefan.nikolic@dronepro.rs",
    dot: "bg-role-pilot",
  },
] as const;

/**
 * Login form (replaces `LoginComponent`). Submits email/password to
 * `POST /api/v1/auth/login`; on success the JWT comes back in the
 * response's `Authorization` header (the body is the user's profile, not
 * the token — see `AuthService.login`), which this stores before sending
 * the browser home. `?registered=1` (set by the register form's redirect)
 * shows the "account created" banner.
 *
 * SOURCE: drone-missions-frontend/.../components/login/login.component.{ts,html}
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const justRegistered = searchParams.get("registered") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Mirrors the form's Validators.required / Validators.email.
  const emailError = !email.trim()
    ? "Email is required."
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? "Enter a valid email address."
      : null;
  const passwordError = !password ? "Password is required." : null;

  /**
   * Fills the form with one demo account.
   *
   * Deliberately does NOT submit. The visitor should see the fields populate
   * and press "Sign in" themselves: an automatic redirect on click is
   * disorienting, and it hides what went wrong when the request fails.
   *
   * The `touched` flags are set for the same reason a real keystroke sets
   * them — so the filled state is exactly what typing would have produced —
   * and any error banner left over from an earlier attempt is cleared, so it
   * cannot sit above freshly filled valid credentials.
   */
  function fillDemoAccount(demoEmail: string) {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    setEmailTouched(true);
    setPasswordTouched(true);
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailTouched(true);
    setPasswordTouched(true);
    if (emailError || passwordError) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await apiFetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        setSubmitError(
          response.status === 401
            ? "Invalid email or password."
            : "Could not sign in. Please try again.",
        );
        setSubmitting(false);
        return;
      }

      const token = extractBearerToken(response.headers.get("Authorization"));
      if (token) {
        storeToken(token);
      }
      // AuthService stores the token from the Authorization header; the
      // landing page itself decides where a logged-in visitor lands.
      router.push("/");
    } catch {
      setSubmitError("Could not sign in. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <>
      <p className="text-primary mb-2.5 text-[11px] font-medium tracking-[0.14em] uppercase">
        Sign in
      </p>
      <h1 className="text-foreground mb-1.5 text-2xl font-bold tracking-tight">Welcome back</h1>
      <p className="text-muted-foreground mb-6 text-sm leading-relaxed">
        Sign in to plan missions and review incoming bids.
      </p>

      {justRegistered && (
        <div
          role="status"
          className="mb-4.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
        >
          Account created — sign in to continue.
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {submitError && (
          <div
            role="alert"
            className="bg-destructive/10 border-destructive/30 text-destructive rounded-lg border px-3 py-2.5 text-sm"
          >
            {submitError}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="email"
            className="text-muted-foreground text-[10.5px] font-medium tracking-wide uppercase"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => setEmailTouched(true)}
            className={cn(
              "border-input bg-secondary/40 text-foreground placeholder:text-muted-foreground/70 focus:border-ring w-full rounded-lg border px-3 py-2.5 text-sm transition-colors outline-none focus:bg-transparent",
              emailTouched && emailError && "border-destructive focus:border-destructive",
            )}
          />
          {emailTouched && emailError && <p className="text-destructive text-xs">{emailError}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="password"
            className="text-muted-foreground text-[10.5px] font-medium tracking-wide uppercase"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onBlur={() => setPasswordTouched(true)}
            className={cn(
              "border-input bg-secondary/40 text-foreground placeholder:text-muted-foreground/70 focus:border-ring w-full rounded-lg border px-3 py-2.5 text-sm transition-colors outline-none focus:bg-transparent",
              passwordTouched && passwordError && "border-destructive focus:border-destructive",
            )}
          />
          {passwordTouched && passwordError && (
            <p className="text-destructive text-xs">{passwordError}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="bg-primary text-primary-foreground mt-1 w-full rounded-lg px-4 py-2.5 text-sm font-semibold shadow-sm transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="text-muted-foreground mt-5 text-center text-sm">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="text-primary font-medium hover:underline">
          Create one
        </Link>
      </p>

      {/* Demo accounts. A `<section>` with a label rather than a bare div so
          the block is reachable as a landmark, and each account is a real
          `<button>` rather than a clickable div so it is keyboard-operable
          and announced as a control. */}
      <section aria-label="Demo accounts" className="border-border mt-6 border-t pt-5">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-muted-foreground font-mono text-[10.5px] font-medium tracking-[0.1em] uppercase">
            Demo accounts
          </h2>
          <span className="text-muted-foreground/70 text-[10.5px]">tap to fill</span>
        </div>

        <div className="space-y-2">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              onClick={() => fillDemoAccount(account.email)}
              /* The visible text says only "Pilot"; the accessible name has
                 to say what activating it actually does. */
              aria-label={`Fill in the ${account.label} demo account`}
              className="border-input hover:bg-accent hover:border-ring flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors"
            >
              <span
                aria-hidden="true"
                className={cn("h-2 w-2 shrink-0 rounded-full", account.dot)}
              />
              {/* `min-w-0` so the email can truncate instead of widening the
                  card on a narrow screen — a flex item will not shrink below
                  its content otherwise. */}
              <span className="min-w-0 flex-1">
                <span className="text-foreground block text-[13px] font-semibold">
                  {account.label}
                </span>
                <span
                  title={account.email}
                  className="text-muted-foreground block truncate font-mono text-[11px]"
                >
                  {account.email}
                </span>
              </span>
            </button>
          ))}
        </div>

        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
          Both sign in with <span className="text-foreground font-mono">{DEMO_PASSWORD}</span>.
        </p>

        {/* Stated plainly and without alert styling: outgoing mail being off
            is information, not a fault, and dressing it as a warning would
            make a working demo look broken. Without it, a visitor who places
            a bid waits for an email that never comes and concludes the
            feature is broken — the notification really is raised, it just is
            not delivered. */}
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          Email delivery is switched off in this demo — you&apos;ll still see every
          notification in the app, but nothing is sent to a real inbox.
        </p>
      </section>
    </>
  );
}
