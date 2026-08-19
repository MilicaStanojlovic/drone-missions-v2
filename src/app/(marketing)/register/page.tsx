import { Suspense } from "react";
import type { Metadata } from "next";
import { RegisterForm } from "@/features/auth/components/register-form";

export const metadata: Metadata = {
  title: "Create account — Drone Missions",
};

/**
 * `/register` (replaces `RegisterComponent`'s route). `RegisterForm` reads
 * the `?role=` query param via `useSearchParams`, which requires a Suspense
 * boundary in the App Router (it opts the subtree out of static rendering).
 */
export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
