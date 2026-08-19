"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, clearToken } from "@/features/auth/auth.client";
import { fetchRatingsForUser, type UserRatings } from "@/features/ratings/rating.client";
import { RatingList } from "@/features/ratings/components/rating-list";
import { RatingStars } from "@/features/ratings/components/rating-stars";
import type { UserResponse } from "@/features/users/user.types";

/**
 * The signed-in user's own profile: who the account is, and the reputation it
 * has earned — headline average/count plus every review received.
 *
 * Ports `ProfileComponent` (template, styles and behaviour). Two reads, in
 * order, exactly as the source sequences them: the profile first, then
 * `forUser(profile.id)` — the ratings call needs an id that only arrives with
 * the profile, which is why the source hangs `loadRatings` off the
 * `profile$` subscription rather than firing both in `ngOnInit`.
 *
 * Where the two differ, and why:
 * - The source reads the profile from `AuthService`'s cached `profile$`
 *   BehaviorSubject and kicks `loadProfile()` to refill it. There is no such
 *   shared client-side cache here (`(app)/layout.tsx` fetches `/users/me` for
 *   the topbar name the same way, with its own `apiFetch`), so this component
 *   does its own read. The source's `if (profile && this.ratings === null)`
 *   guard exists only because a BehaviorSubject can emit more than once; a
 *   single fetch cannot, so the effect below needs no equivalent.
 * - Both failure paths are the source's: a rejected read is logged and left at
 *   that, so the section keeps its "Loading…" line. Nothing here retries or
 *   shows an error state, because the original doesn't either.
 *
 * `logout()` is the source's: purely local (`AuthService.logout` just discards
 * the token) plus a redirect to `/login`. It does NOT call
 * `POST /api/v1/auth/logout` — that call belongs to the topbar's button, which
 * the plan added there deliberately; this second, in-card button stays the
 * local-only one the source wrote.
 *
 * SOURCE: drone-missions-frontend/.../components/profile/profile.component.{ts,html,css}
 */

/**
 * The profile as the API returns it — `UserResponse` with its `createdAt` as
 * the ISO-8601 string `NextResponse.json` writes and `response.json()` reads
 * back (the server type holds a `Date`). Mirrors how the Angular
 * `UserResponse` model types the backend's `Instant` as `string`. The import
 * is `import type`, so it is erased at compile time and never pulls the
 * `server-only` module into this bundle — the same technique `(app)/layout.tsx`
 * and `rating.client.ts` use.
 */
type Profile = Omit<UserResponse, "createdAt"> & { createdAt: string };

/**
 * Ports `roleLabel`. Kept as the source's ternary, quirk included: an ADMIN
 * account visiting its own profile is labelled "Pilot" (the topbar's own
 * `ROLE_LABEL` map, which does know about admins, is a different component's
 * port of a different source method).
 */
function roleLabel(role: Profile["role"]): string {
  return role === "DESIGNER" ? "Mission Designer" : "Pilot";
}

/**
 * Ports `roleColor` — designer blue, pilot green — with the same ternary and
 * therefore the same fall-through for ADMIN (blue). The two hex values are the
 * canvas's `--role-designer` / `--role-pilot`, but stay literals here because
 * the source composes them into `rgba`-ish suffixes (`+ '1a'`, `+ '55'`) for
 * the tint and border, which needs the value, not the var.
 */
function roleColor(role: Profile["role"]): string {
  return role === "PILOT" ? "#12a06a" : "#2f6bff";
}

/** Ports `initial` — first letter of the username, uppercased. */
function initial(name: string): string {
  return name?.trim()?.[0]?.toUpperCase() ?? "?";
}

/** Angular's `| date: 'longDate'` ("June 15, 2015"). */
function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const CARD =
  "bg-card border-border rounded-[14px] border p-[26px] shadow-[0_1px_2px_rgba(20,35,55,0.04),0_10px_30px_rgba(20,35,55,0.05)]";
const STATE = "text-muted-foreground py-10";

export function ProfileView() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ratings, setRatings] = useState<UserRatings | null>(null);

  // `ngOnInit`'s `auth.loadProfile()`.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/v1/users/me")
      .then((response) => (response.ok ? (response.json() as Promise<Profile>) : null))
      .then((loaded) => {
        if (!cancelled && loaded) {
          setProfile(loaded);
        }
      })
      .catch((cause: unknown) => console.error("Failed to load profile", cause));
    return () => {
      cancelled = true;
    };
  }, []);

  // Ports `loadRatings(profile.id)`, hung off the profile arriving.
  useEffect(() => {
    if (!profile) {
      return;
    }
    let cancelled = false;
    fetchRatingsForUser(profile.id)
      .then((loaded) => {
        if (!cancelled) {
          setRatings(loaded);
        }
      })
      .catch((cause: unknown) => console.error("Failed to load ratings", cause));
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const accent = profile ? roleColor(profile.role) : "#2f6bff";

  /** Ports `logout()`. */
  function logout(): void {
    clearToken();
    router.push("/login");
  }

  return (
    <section className="animate-in fade-in slide-in-from-bottom-2 text-foreground mx-auto max-w-[640px] px-6 pt-8 pb-[72px] duration-[250ms] ease-out motion-reduce:animate-none">
      <header className="mb-[22px]">
        <div className="mb-2 font-mono text-[11px] tracking-[0.14em] text-[#93a1b0]">ACCOUNT</div>
        <h1 className="m-0 text-[30px] font-bold tracking-[-0.01em] text-[#141e28]">My Profile</h1>
      </header>

      {profile ? (
        <>
          <div className={CARD}>
            <div className="flex items-center gap-4 border-b border-[#eef2f6] pb-[22px]">
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-2xl font-bold"
                style={{ background: `${accent}1a`, color: accent }}
              >
                {initial(profile.username)}
              </div>
              <div>
                <div className="mb-[7px] text-xl font-bold break-words text-[#141e28]">
                  {profile.username}
                </div>
                <span
                  className="inline-flex items-center gap-1.5 rounded-[20px] border px-2.5 py-1 font-mono text-[10px] font-semibold tracking-[0.1em] uppercase"
                  style={{
                    color: accent,
                    background: `${accent}1a`,
                    borderColor: `${accent}55`,
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: accent }}
                  />
                  {roleLabel(profile.role)}
                </span>
              </div>
            </div>

            <dl className="m-0 pt-[22px] pb-1">
              {[
                { label: "Email", value: profile.email },
                { label: "Role", value: roleLabel(profile.role) },
                { label: "Member since", value: longDate(profile.createdAt) },
              ].map((field) => (
                <div
                  key={field.label}
                  className="flex items-baseline justify-between gap-4 border-b border-[#f2f5f8] py-[11px] last:border-b-0"
                >
                  <dt className="font-mono text-[10.5px] tracking-[0.08em] text-[#93a1b0] uppercase">
                    {field.label}
                  </dt>
                  <dd className="m-0 text-right text-sm break-words">{field.value}</dd>
                </div>
              ))}
            </dl>

            <button
              type="button"
              onClick={logout}
              className="bg-card border-input mt-[22px] w-full cursor-pointer rounded-[9px] border p-[11px] text-sm font-medium text-[#43525f] transition-colors hover:border-[#c3ccd6] hover:text-[#1b2732]"
            >
              Log out
            </button>
          </div>

          <div className={`${CARD} mt-4`}>
            <div className="mb-3.5 flex items-center justify-between gap-3">
              <h2 className="m-0 text-[15px] font-semibold">Ratings</h2>
              {ratings && <RatingStars average={ratings.average} count={ratings.count} />}
            </div>
            {ratings ? (
              <RatingList ratings={ratings.ratings} />
            ) : (
              <p className={STATE}>Loading ratings…</p>
            )}
          </div>
        </>
      ) : (
        <p className={STATE}>Loading your profile…</p>
      )}
    </section>
  );
}
