"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { apiFetch, extractBearerToken, storeToken } from "@/features/auth/auth.client";

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
    </>
  );
}
