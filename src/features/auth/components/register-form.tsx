"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/features/auth/auth.client";

/** The two roles self-registration may pick — mirrors the form's role radio group; ADMIN is never offered here (server-side self-registration guard rejects it anyway, see `AdminRegistrationNotAllowedError`). */
type RegisterableRole = "DESIGNER" | "PILOT";

function roleFromQuery(value: string | null): RegisterableRole | "" {
  return value === "DESIGNER" || value === "PILOT" ? value : "";
}

/**
 * Register form (replaces `RegisterComponent`). Submits
 * username/email/password/role to `POST /api/v1/auth/register`, then hands
 * off to the login page with `?registered=1` for the success banner —
 * mirroring the source's `router.navigate(['/login'], { queryParams: {
 * registered: 1 } })`. `?role=DESIGNER|PILOT` (linked from the landing page)
 * prefills the role choice.
 *
 * SOURCE: drone-missions-frontend/.../components/register/register.component.{ts,html}
 */
export function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<RegisterableRole | "">(() =>
    roleFromQuery(searchParams.get("role")),
  );
  const [touched, setTouched] = useState({
    username: false,
    email: false,
    password: false,
    role: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Mirrors Validators.required / Validators.email / Validators.minLength(8).
  const usernameError = !username.trim() ? "Username is required." : null;
  const emailError = !email.trim()
    ? "Email is required."
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? "Enter a valid email address."
      : null;
  const passwordError = !password
    ? "Password is required."
    : password.length < 8
      ? "Password must be at least 8 characters."
      : null;
  const roleError = !role ? "Choose how you want to join." : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched({ username: true, email: true, password: true, role: true });
    if (usernameError || emailError || passwordError || roleError) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await apiFetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password, role }),
      });

      if (!response.ok) {
        setSubmitError(
          response.status === 409
            ? "That email is already registered."
            : "Could not create your account. Please try again.",
        );
        setSubmitting(false);
        return;
      }

      router.push("/login?registered=1");
    } catch {
      setSubmitError("Could not create your account. Please try again.");
      setSubmitting(false);
    }
  }

  const fieldClassName = (invalid: boolean) =>
    cn(
      "border-input bg-secondary/40 text-foreground placeholder:text-muted-foreground/70 focus:border-ring w-full rounded-lg border px-3 py-2.5 text-sm outline-none transition-colors focus:bg-transparent",
      invalid && "border-destructive focus:border-destructive",
    );

  return (
    <>
      <p className="text-primary mb-2.5 text-[11px] font-medium tracking-[0.14em] uppercase">
        Register
      </p>
      <h1 className="text-foreground mb-1.5 text-2xl font-bold tracking-tight">
        Create your account
      </h1>
      <p className="text-muted-foreground mb-6 text-sm leading-relaxed">
        Join the marketplace for drone flight missions.
      </p>

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
            htmlFor="username"
            className="text-muted-foreground text-[10.5px] font-medium tracking-wide uppercase"
          >
            Username
          </label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            placeholder="jane.pilot"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, username: true }))}
            className={fieldClassName(touched.username && !!usernameError)}
          />
          {touched.username && usernameError && (
            <p className="text-destructive text-xs">{usernameError}</p>
          )}
        </div>

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
            onBlur={() => setTouched((current) => ({ ...current, email: true }))}
            className={fieldClassName(touched.email && !!emailError)}
          />
          {touched.email && emailError && <p className="text-destructive text-xs">{emailError}</p>}
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
            autoComplete="new-password"
            placeholder="At least 8 characters"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, password: true }))}
            className={fieldClassName(touched.password && !!passwordError)}
          />
          {touched.password && passwordError && (
            <p className="text-destructive text-xs">{passwordError}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[10.5px] font-medium tracking-wide uppercase">
            I want to join as
          </span>
          <div role="radiogroup" aria-label="Account role" className="grid grid-cols-2 gap-2.5">
            {(
              [
                {
                  value: "DESIGNER",
                  name: "Designer",
                  desc: "List and own missions, choose who flies them.",
                },
                {
                  value: "PILOT",
                  name: "Pilot",
                  desc: "Find available work, bid on it, and fly it.",
                },
              ] as const
            ).map((option) => (
              <label
                key={option.value}
                className={cn(
                  "bg-secondary/40 border-input relative flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors",
                  role === option.value && "border-primary ring-primary/40 bg-transparent ring-1",
                )}
              >
                <input
                  type="radio"
                  name="role"
                  value={option.value}
                  checked={role === option.value}
                  onChange={() => setRole(option.value)}
                  onBlur={() => setTouched((current) => ({ ...current, role: true }))}
                  className="absolute h-0 w-0 opacity-0"
                />
                <span className="text-foreground text-sm font-semibold">{option.name}</span>
                <span className="text-muted-foreground text-[11.5px] leading-tight">
                  {option.desc}
                </span>
              </label>
            ))}
          </div>
          {touched.role && roleError && <p className="text-destructive text-xs">{roleError}</p>}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="bg-primary text-primary-foreground mt-1 w-full rounded-lg px-4 py-2.5 text-sm font-semibold shadow-sm transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60"
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="text-muted-foreground mt-5 text-center text-sm">
        Already have an account?{" "}
        <Link href="/login" className="text-primary font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
