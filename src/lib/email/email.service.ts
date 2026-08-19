import "server-only";
import { createElement, type ReactElement } from "react";
import { render } from "@react-email/render";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { BidAcceptedEmail } from "@/emails/bid-accepted";
import { BidRejectedEmail } from "@/emails/bid-rejected";
import { MissionCancelledEmail } from "@/emails/mission-cancelled";
import { MissionOverdueEmail } from "@/emails/mission-overdue";
import { NewBidEmail } from "@/emails/new-bid";
import { getResendClient } from "./client";
import type {
  EmailAmount,
  EmailMission,
  EmailRecipient,
  EmailService,
  NewBidEmailInput,
} from "./email.types";

/**
 * Sends the app-styled HTML emails (replaces
 * `business.service.mail.EmailService`).
 *
 * Rendering uses the React Email components under `src/emails/` (the 1:1 port
 * of the Thymeleaf templates); delivery uses Resend instead of JavaMail/SMTP,
 * per `MIGRATION_PLAN.md` §2–3. Everything else is the source's behavior,
 * step for step:
 *
 *  - **Best-effort, never propagating.** Each send is wrapped so neither a
 *    render failure nor a transport failure can reach the caller — the port
 *    of the source's `@Async void` + "a mail failure must never break the
 *    bid/scheduler flow" comment. There is no Node analogue of `@Async`'s
 *    thread hand-off worth reproducing here: the methods return a promise
 *    that always resolves, so a caller can `await` them (tests do) or drop
 *    them with `void emailService.sendNewBid(...)` for the same
 *    fire-and-forget shape the annotation gave, with no risk of an unhandled
 *    rejection either way.
 *  - **Render first, always.** The HTML is produced before the
 *    `MAIL_ENABLED` check, because the disabled branch's whole purpose is to
 *    log what *would* have been sent. A render failure logs and returns
 *    without ever reaching the transport.
 *  - **`MAIL_ENABLED=false` (the default) logs instead of sending**, so the
 *    app runs with no mail credentials at all.
 *  - **`MAIL_REDIRECT_TO` redirects dev mail**, tagging the subject with the
 *    address the message was actually meant for.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/mail/EmailService.java
 * - drone-missions-backend/.../business/service/mail/NewBidEmail.java
 */

/** Builds the mission-page CTA link — `missionUrl(Long)` in the source. */
function missionUrl(missionId: number): string {
  return `${env.APP_URL}/missions/${missionId}`;
}

interface SendParams {
  /** The intended recipient — stays the "intended" address even when redirected. */
  to: string;
  subject: string;
  /** The rendered-on-demand template element. */
  element: ReactElement;
  /** Template id used only in log lines, matching the source's `email/<name>` strings. */
  template: string;
}

/**
 * The private `send(to, subject, template, ctx)` of the source, in order:
 * render → (disabled? log the HTML and stop) → (redirect? rewrite recipient
 * and tag subject) → dispatch, logging either outcome.
 *
 * One transport-shaped difference to be aware of: `mailSender.send(...)`
 * threw on failure, whereas the Resend SDK **returns** `{ data, error }` and
 * only throws on network-level faults. Both are funnelled into the same
 * catch-and-log branch below, so an API-level rejection (bad key, suppressed
 * address, rate limit) is treated exactly like the `MessagingException` the
 * source swallowed.
 */
async function send({ to, subject, element, template }: SendParams): Promise<void> {
  let html: string;
  try {
    html = await render(element);
  } catch (error) {
    logger.error(
      { err: error, template, to },
      `Failed to render email template ${template} for ${to}`,
    );
    return;
  }

  if (!env.MAIL_ENABLED) {
    logger.info(
      { to, subject, html },
      `[mail disabled] would send to=${to} subject="${subject}"\n${html}`,
    );
    return;
  }

  // Dev testing: when MAIL_REDIRECT_TO is set, deliver every message to that
  // inbox instead of the real recipient, tagging the subject with the address
  // it was actually meant for. Blank (the default) = normal delivery to `to`.
  // `env.MAIL_REDIRECT_TO` is already trimmed by the schema, so this plain
  // `!== ""` is the port of Spring's `!redirectTo.isBlank()`.
  let recipient = to;
  let finalSubject = subject;
  if (env.MAIL_REDIRECT_TO !== "") {
    finalSubject = `[→ ${to}] ${subject}`;
    recipient = env.MAIL_REDIRECT_TO;
  }

  try {
    const { error } = await getResendClient().emails.send({
      from: env.MAIL_FROM,
      to: recipient,
      subject: finalSubject,
      html,
    });
    if (error) {
      throw new Error(`Resend rejected the message: ${error.name} — ${error.message}`);
    }
    logger.info(
      { to: recipient, intended: to, subject: finalSubject },
      `Sent email to=${recipient} (intended ${to}) subject="${finalSubject}"`,
    );
  } catch (error) {
    // Best-effort: a mail failure must never break the bid/scheduler flow.
    logger.error(
      { err: error, to: recipient, subject: finalSubject },
      `Failed to send email to=${recipient} subject="${finalSubject}"`,
    );
  }
}

/** Tell a mission's owner that a pilot has placed a bid on it. */
export async function sendNewBid(email: NewBidEmailInput): Promise<void> {
  const { designer, mission } = email;
  await send({
    to: designer.email,
    subject: `New bid on "${mission.name}"`,
    template: "email/new-bid",
    element: createElement(NewBidEmail, {
      recipientName: designer.username,
      pilotName: email.pilotName,
      missionName: mission.name,
      amount: email.amount,
      bidMessage: email.message,
      ctaUrl: missionUrl(mission.id),
    }),
  });
}

/**
 * Notify the pilot that their bid was accepted or rejected — the one method
 * whose template, subject *and* CTA target all fork on the flag: accepted
 * links to the mission page, rejected back to the browse list.
 */
export async function sendBidDecision(
  pilot: EmailRecipient,
  mission: EmailMission,
  amount: EmailAmount,
  accepted: boolean,
): Promise<void> {
  if (accepted) {
    await send({
      to: pilot.email,
      subject: `Your bid on "${mission.name}" was accepted`,
      template: "email/bid-accepted",
      element: createElement(BidAcceptedEmail, {
        recipientName: pilot.username,
        missionName: mission.name,
        amount,
        ctaUrl: missionUrl(mission.id),
      }),
    });
    return;
  }

  // The rejected template renders no amount panel — the source still binds
  // `amount` into the context here, and it still goes unread. Kept in the
  // signature (it is part of the port's contract) but not passed on.
  await send({
    to: pilot.email,
    subject: `Update on your bid for "${mission.name}"`,
    template: "email/bid-rejected",
    element: createElement(BidRejectedEmail, {
      recipientName: pilot.username,
      missionName: mission.name,
      ctaUrl: `${env.APP_URL}/missions`,
    }),
  });
}

/** Ask the winning pilot whether the flight has ended (mission past its end date). */
export async function sendMissionOverdue(
  pilot: EmailRecipient,
  mission: EmailMission,
): Promise<void> {
  await send({
    to: pilot.email,
    subject: `Has your flight for "${mission.name}" ended?`,
    template: "email/mission-overdue",
    element: createElement(MissionOverdueEmail, {
      recipientName: pilot.username,
      missionName: mission.name,
      ctaUrl: missionUrl(mission.id),
    }),
  });
}

/** Tell the awarded pilot that the designer cancelled the mission they had won. */
export async function sendMissionCancelled(
  pilot: EmailRecipient,
  mission: EmailMission,
): Promise<void> {
  await send({
    to: pilot.email,
    subject: `Mission "${mission.name}" was cancelled`,
    template: "email/mission-cancelled",
    element: createElement(MissionCancelledEmail, {
      recipientName: pilot.username,
      missionName: mission.name,
      ctaUrl: missionUrl(mission.id),
    }),
  });
}

/**
 * The port as one object, for callers that prefer injecting a collaborator
 * (and for tests that stub it) over importing four functions — the closest
 * equivalent to the injected `EmailService` bean the source's `BidService`
 * and scheduled sweep hold.
 */
export const emailService: EmailService = {
  sendNewBid,
  sendBidDecision,
  sendMissionOverdue,
  sendMissionCancelled,
};
