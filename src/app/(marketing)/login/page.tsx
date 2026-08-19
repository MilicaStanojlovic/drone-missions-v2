import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "@/features/auth/components/login-form";

export const metadata: Metadata = {
  title: "Sign in — Drone Missions",
};

/**
 * `/login` (replaces `LoginComponent`'s route). `LoginForm` reads the
 * `?registered=1` query param via `useSearchParams`, which requires a
 * Suspense boundary in the App Router (it opts the subtree out of static
 * rendering).
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
