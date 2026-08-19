"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { ApiError, serverMessage } from "@/lib/api/client";
import { createAdmin } from "../user.client";

/**
 * Admin view: register another admin account (role is forced server-side).
 *
 * A direct port of `AdminRegisterComponent` — template, styles and behaviour.
 * The reactive form's three validators (`required`, `email`,
 * `minLength(8)`) become the three derived error strings below, and
 * `markAllAsTouched()` on an invalid submit becomes flipping every `touched`
 * flag at once, so the messages appear exactly when the source shows them.
 * The password rule mirrors the backend constraint (`newAdminSchema` /
 * `NewAdminRequest`), which is the real enforcement — this only saves a
 * round-trip.
 *
 * The 409 special case is the source's: a duplicate email gets the fixed
 * "That email is already registered." wording rather than the server's own
 * message, everything else falls back to `serverMessage(...)`.
 *
 * On success the source shows a toast and navigates to `/admin/users`. Its
 * `ToastService` is root-provided and `<app-toast>` is mounted once in
 * `app.component.html`, so the message survives that navigation; nothing here
 * outlives an unmount, so the username travels to the list page as
 * `?created=`, which raises the identical toast on arrival — the same hand-off
 * `register-form.tsx` → `login-form.tsx` already uses with `?registered=1`.
 *
 * SOURCE: drone-missions-frontend/.../components/admin-register/admin-register.component.{ts,html,css}
 * DESIGN: design/DroneMissions.dc.html (the admin section's tokens — mono
 * eyebrow `#6d5ef0`, `#2f6bff` primary, `#e8edf2` panel border)
 */

/** The field shell shared by the three inputs; `invalid` swaps the border red. */
function fieldClassName(invalid: boolean): string {
  return cn(
    "bg-card text-foreground w-full rounded-[9px] border border-[#dbe2ea] px-3 py-2.5 text-[13.5px] outline-none focus:border-[#6d5ef0]",
    invalid && "border-[#e04a3f] focus:border-[#e04a3f]",
  );
}

const LABEL = "mb-1.5 block font-mono text-[10.5px] tracking-[0.09em] text-[#5c6b7a] uppercase";

export function AdminRegister() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState({ username: false, email: false, password: false });
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

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setTouched({ username: true, email: true, password: true });
    if (usernameError || emailError || passwordError) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    createAdmin({ username, email, password })
      .then((created) => {
        router.push(`/admin/users?created=${encodeURIComponent(created.username)}`);
      })
      .catch((cause: unknown) => {
        console.error(cause);
        setSubmitError(
          cause instanceof ApiError && cause.status === 409
            ? "That email is already registered."
            : serverMessage(cause, "Could not create the admin account. Please try again."),
        );
        setSubmitting(false);
      });
  }

  return (
    <section className="text-foreground mx-auto max-w-[520px] px-6 pt-8 pb-[72px]">
      <header className="mb-[22px]">
        <div className="text-role-admin mb-2 font-mono text-[11px] tracking-[0.14em]">
          PLATFORM ADMIN
        </div>
        <h1 className="m-0 text-[30px] font-bold tracking-[-0.01em] text-[#141e28]">New Admin</h1>
        <p className="mt-2 mb-0 text-[13.5px] text-[#5c6b7a]">
          Create another administrator account.
        </p>
      </header>

      <form
        noValidate
        onSubmit={handleSubmit}
        className="bg-card rounded-xl border border-[#e8edf2] p-5 shadow-[0_1px_2px_rgba(20,35,55,0.04)]"
      >
        {submitError && (
          <div
            role="alert"
            className="mb-4 rounded-[9px] border border-[#f0d5d3] bg-[#fdf6f5] px-3 py-2.5 text-[13px] text-[#c0574d]"
          >
            {submitError}
          </div>
        )}

        <div className="mb-4">
          <label className={LABEL} htmlFor="username">
            Username
          </label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, username: true }))}
            className={fieldClassName(touched.username && !!usernameError)}
          />
          {touched.username && usernameError && (
            <p className="mt-[5px] mb-0 text-xs text-[#c0574d]">{usernameError}</p>
          )}
        </div>

        <div className="mb-4">
          <label className={LABEL} htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, email: true }))}
            className={fieldClassName(touched.email && !!emailError)}
          />
          {touched.email && emailError && (
            <p className="mt-[5px] mb-0 text-xs text-[#c0574d]">{emailError}</p>
          )}
        </div>

        <div className="mb-4">
          <label className={LABEL} htmlFor="password">
            Initial password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, password: true }))}
            className={fieldClassName(touched.password && !!passwordError)}
          />
          {touched.password && passwordError && (
            <p className="mt-[5px] mb-0 text-xs text-[#c0574d]">{passwordError}</p>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-3">
          <Link
            href="/admin/users"
            className="rounded-[7px] px-3.5 py-2.5 text-[13px] font-medium text-[#5c6b7a] no-underline transition-colors hover:bg-[#f0f3f7] hover:text-[#1b2732]"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="bg-primary text-primary-foreground cursor-pointer rounded-[9px] border-none px-[18px] py-[11px] text-sm font-semibold shadow-[0_4px_16px_rgba(47,107,255,0.28)] transition-colors enabled:hover:bg-[#1e5ae6] disabled:cursor-default disabled:opacity-60"
          >
            {submitting ? "Creating…" : "Create admin"}
          </button>
        </div>
      </form>
    </section>
  );
}
