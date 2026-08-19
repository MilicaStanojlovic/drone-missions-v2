import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";

/**
 * Mail transport handle (replaces Spring Boot's auto-configured
 * `JavaMailSender` bean, which `EmailService` took by constructor injection).
 *
 * The stack decision from `MIGRATION_PLAN.md` §2–3 is `resend` instead of
 * SMTP/JavaMail, so the "bean" here is a lazily-created `Resend` client.
 *
 * Lazy on purpose, exactly like `src/db/client.ts`'s pool: `RESEND_API_KEY`
 * is optional in `src/lib/env.ts` (the app must boot, build and test with no
 * mail credentials — that is the whole point of `MAIL_ENABLED=false` being
 * the default), and the `Resend` constructor *throws* when handed no key.
 * Constructing at module scope would therefore break `next build`, the
 * Vitest suite, and every dev run without an API key — including the ones
 * that never send a single email. Nothing here opens a socket or reads a
 * credential until `getResendClient()` is actually called on a send path
 * that has `MAIL_ENABLED=true`.
 *
 * Cached on `globalThis` for the same reason the DB pool is: Next.js
 * dev-mode hot-reload re-evaluates modules on every edit, and a per-edit
 * client would pile up keep-alive HTTP agents.
 */

const globalForResend = globalThis as unknown as {
  __droneMissionsResend?: Resend;
};

/**
 * Returns the process-wide Resend client, creating it on first call.
 *
 * @throws Error if `RESEND_API_KEY` is not configured. Callers on the send
 * path run inside the same try/catch that guards the send itself, so a
 * misconfigured key degrades to a logged "failed to send" — the same
 * best-effort outcome the source gives an SMTP failure — rather than
 * breaking the bid or sweep that triggered the mail.
 */
export function getResendClient(): Resend {
  if (!globalForResend.__droneMissionsResend) {
    if (!env.RESEND_API_KEY) {
      throw new Error(
        "RESEND_API_KEY not configured — set it in .env.local (or the environment) before " +
          "running with MAIL_ENABLED=true. See .env.example.",
      );
    }
    globalForResend.__droneMissionsResend = new Resend(env.RESEND_API_KEY);
  }
  return globalForResend.__droneMissionsResend;
}

/**
 * Drops the cached client so the next `getResendClient()` builds a fresh one.
 *
 * No runtime path calls this (the client lives for the life of the process,
 * like the injected `JavaMailSender` did) — it exists for tests, which swap
 * the mocked `Resend` constructor or the API-key env between cases and must
 * not inherit a client built by an earlier one.
 */
export function resetResendClient(): void {
  globalForResend.__droneMissionsResend = undefined;
}
