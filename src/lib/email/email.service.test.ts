import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

/**
 * Vitest suite for the mail port (`src/lib/email/`).
 *
 * The Spring source has **no** `EmailServiceTest` (verified: nothing under
 * `src/test/java/.../mail/`), so there is no JUnit suite to mirror
 * case-for-case. The spec asserted here is `EmailService.java`'s own
 * `send(to, subject, template, ctx)` pipeline read directly from the source —
 * render → (disabled? log the HTML and stop) → (redirect? rewrite recipient
 * and tag subject) → dispatch, with every failure swallowed — plus the five
 * Thymeleaf templates' copy and variable bindings.
 *
 * Two mocks, no live transport:
 *  - `resend` — so nothing leaves the machine and each case can drive the
 *    outcome (`{ error }`, a thrown network fault, or success).
 *  - `@/lib/env` — a plain mutable object, the same pattern
 *    `src/app/api/health/route.test.ts` uses, so a case can flip
 *    `MAIL_ENABLED` / `MAIL_REDIRECT_TO` between runs. `env` is a
 *    parsed-once singleton in the real module, so it cannot be re-read per
 *    test any other way.
 *  - `@react-email/render` is wrapped rather than replaced: it delegates to
 *    the real renderer (the template cases below need real HTML) unless a
 *    case installs `renderOverride.fn` to exercise the render-failure branch.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/mail/EmailService.java
 * - drone-missions-backend/.../resources/templates/email/*.html
 */

const { sendMock, renderOverride } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  /** When `fn` is set, the service's `render(...)` call runs it instead of the real renderer. */
  renderOverride: { fn: null as null | (() => Promise<string>) },
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
    constructor(public readonly apiKey: string) {}
  },
}));

vi.mock("@react-email/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@react-email/render")>();
  return {
    ...actual,
    render: (...args: Parameters<typeof actual.render>) =>
      renderOverride.fn ? renderOverride.fn() : actual.render(...args),
  };
});

vi.mock("@/lib/env", () => ({
  env: {
    MAIL_ENABLED: false,
    MAIL_FROM: "DroneMissions <no-reply@dronemissions.app>",
    MAIL_REDIRECT_TO: "",
    RESEND_API_KEY: "re_test_key",
    APP_URL: "https://app.example.test",
  },
}));

import { render } from "@react-email/render";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { BidAcceptedEmail } from "@/emails/bid-accepted";
import { BidRejectedEmail } from "@/emails/bid-rejected";
import { MissionCancelledEmail } from "@/emails/mission-cancelled";
import { MissionOverdueEmail } from "@/emails/mission-overdue";
import { NewBidEmail } from "@/emails/new-bid";
import { resetResendClient } from "./client";
import {
  emailService,
  sendBidDecision,
  sendMissionCancelled,
  sendMissionOverdue,
  sendNewBid,
} from "./email.service";
import type { EmailMission, EmailRecipient } from "./email.types";

/** Baseline env for a case that does not care — restored before every test. */
const defaultEnv = {
  MAIL_ENABLED: false,
  MAIL_FROM: "DroneMissions <no-reply@dronemissions.app>",
  MAIL_REDIRECT_TO: "",
  RESEND_API_KEY: "re_test_key" as string | undefined,
  APP_URL: "https://app.example.test",
};

const designer: EmailRecipient = { email: "designer@example.test", username: "Dana" };
const pilot: EmailRecipient = { email: "pilot@example.test", username: "Pip" };
const mission: EmailMission = { id: 42, name: "Bridge survey", location: "Rotterdam" };

let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.assign(env, defaultEnv);
  renderOverride.fn = null;
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "msg_1" }, error: null });
  // The Resend handle is cached on globalThis (like the DB pool), so a case
  // that ran with a different RESEND_API_KEY must not leak its client.
  resetResendClient();
  infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
  errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetResendClient();
});

/** The single `emails.send({from, to, subject, html})` payload of the run. */
function sentPayload(): { from: string; to: string; subject: string; html: string } {
  expect(sendMock).toHaveBeenCalledTimes(1);
  return sendMock.mock.calls[0][0];
}

/** The message string of the single `logger.info` line of the run. */
function loggedInfo(): { context: Record<string, unknown>; message: string } {
  expect(infoSpy).toHaveBeenCalledTimes(1);
  const [context, message] = infoSpy.mock.calls[0];
  return { context: context as Record<string, unknown>, message: message as string };
}

describe("email templates", () => {
  it("new-bid renders the recipient, pilot, mission, amount, quote and CTA", async () => {
    const html = await render(
      createElement(NewBidEmail, {
        recipientName: "Dana",
        pilotName: "Pip",
        missionName: "Bridge survey",
        amount: "1250.00",
        bidMessage: "Happy to fly this on short notice.",
        ctaUrl: "https://app.example.test/missions/42",
      }),
    );

    expect(html).toContain("New bid");
    expect(html).toContain("You have a new bid");
    expect(html).toContain("Dana");
    expect(html).toContain("Pip");
    expect(html).toContain("Bridge survey");
    expect(html).toContain("Bid amount");
    expect(html).toContain("1250.00");
    expect(html).toContain("Happy to fly this on short notice.");
    expect(html).toContain('href="https://app.example.test/missions/42"');
    expect(html).toContain("Review the bid");
  });

  it("new-bid omits the quote block entirely when the bid carried no message", async () => {
    const withMessage = await render(
      createElement(NewBidEmail, {
        recipientName: "Dana",
        pilotName: "Pip",
        missionName: "Bridge survey",
        amount: 1250,
        bidMessage: "Happy to fly this on short notice.",
        ctaUrl: "https://app.example.test/missions/42",
      }),
    );
    // `th:if="${bidMessage}"` in the source — null and "" both hide the block.
    const withoutMessage = await render(
      createElement(NewBidEmail, {
        recipientName: "Dana",
        pilotName: "Pip",
        missionName: "Bridge survey",
        amount: 1250,
        bidMessage: null,
        ctaUrl: "https://app.example.test/missions/42",
      }),
    );

    // The curly quotes wrapping the message are the block's tell-tale.
    expect(withMessage).toContain("“");
    expect(withoutMessage).not.toContain("“");
    expect(withoutMessage).not.toContain("Happy to fly this on short notice.");
    // Everything else still renders.
    expect(withoutMessage).toContain("1250");
    expect(withoutMessage).toContain("Bid amount");
  });

  it("bid-accepted renders the winning amount and the mission-page CTA", async () => {
    const html = await render(
      createElement(BidAcceptedEmail, {
        recipientName: "Pip",
        missionName: "Bridge survey",
        amount: "1250.00",
        ctaUrl: "https://app.example.test/missions/42",
      }),
    );

    expect(html).toContain("Bid accepted");
    expect(html).toContain("Your bid was accepted");
    expect(html).toContain("Pip");
    expect(html).toContain("Bridge survey");
    expect(html).toContain("Your winning bid");
    expect(html).toContain("1250.00");
    expect(html).toContain('href="https://app.example.test/missions/42"');
    expect(html).toContain("View the mission");
  });

  it("bid-rejected renders no amount panel and links to the browse list", async () => {
    const html = await render(
      createElement(BidRejectedEmail, {
        recipientName: "Pip",
        missionName: "Bridge survey",
        ctaUrl: "https://app.example.test/missions",
      }),
    );

    expect(html).toContain("Bid update");
    expect(html).toContain("Your bid wasn&#x27;t selected");
    expect(html).toContain("Pip");
    expect(html).toContain("Bridge survey");
    expect(html).toContain('href="https://app.example.test/missions"');
    expect(html).toContain("Browse open missions");
    // No amount box on this one, even though the source still binds `amount`.
    expect(html).not.toContain("Your winning bid");
    expect(html).not.toContain("Bid amount");
  });

  it("mission-cancelled renders the cancellation copy and the mission CTA", async () => {
    const html = await render(
      createElement(MissionCancelledEmail, {
        recipientName: "Pip",
        missionName: "Bridge survey",
        ctaUrl: "https://app.example.test/missions/42",
      }),
    );

    expect(html).toContain("Mission update");
    expect(html).toContain("This mission was cancelled");
    expect(html).toContain("Pip");
    expect(html).toContain("Bridge survey");
    expect(html).toContain('href="https://app.example.test/missions/42"');
    expect(html).toContain("View the mission");
  });

  it("mission-overdue renders the flight-check nudge and the mission CTA", async () => {
    const html = await render(
      createElement(MissionOverdueEmail, {
        recipientName: "Pip",
        missionName: "Bridge survey",
        ctaUrl: "https://app.example.test/missions/42",
      }),
    );

    expect(html).toContain("Flight check");
    expect(html).toContain("Has your flight ended?");
    expect(html).toContain("Pip");
    expect(html).toContain("Bridge survey");
    expect(html).toContain('href="https://app.example.test/missions/42"');
    expect(html).toContain("Mark mission finished");
  });
});

describe("MAIL_ENABLED=false (the default)", () => {
  it("logs the rendered HTML instead of sending", async () => {
    await sendNewBid({
      designer,
      mission,
      pilotName: "Pip",
      amount: "1250.00",
      message: "Happy to fly this on short notice.",
    });

    expect(sendMock).not.toHaveBeenCalled();
    const { context, message } = loggedInfo();
    expect(message).toContain(
      '[mail disabled] would send to=designer@example.test subject="New bid on "Bridge survey""',
    );
    // The whole point of the disabled branch: the HTML that *would* have gone out.
    expect(message).toContain("You have a new bid");
    expect(context).toMatchObject({
      to: "designer@example.test",
      subject: 'New bid on "Bridge survey"',
    });
    expect(context.html).toContain("Happy to fly this on short notice.");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never touches the transport even when no API key is configured", async () => {
    env.RESEND_API_KEY = undefined;

    await sendMissionOverdue(pilot, mission);

    expect(sendMock).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("MAIL_REDIRECT_TO", () => {
  beforeEach(() => {
    env.MAIL_ENABLED = true;
  });

  it("delivers to the intended recipient when blank", async () => {
    await sendMissionCancelled(pilot, mission);

    expect(sentPayload()).toMatchObject({
      from: "DroneMissions <no-reply@dronemissions.app>",
      to: "pilot@example.test",
      subject: 'Mission "Bridge survey" was cancelled',
    });
  });

  it("rewrites the recipient and tags the subject with the intended address", async () => {
    env.MAIL_REDIRECT_TO = "dev-inbox@example.test";

    await sendMissionCancelled(pilot, mission);

    const payload = sentPayload();
    expect(payload.to).toBe("dev-inbox@example.test");
    expect(payload.subject).toBe('[→ pilot@example.test] Mission "Bridge survey" was cancelled');
    // The body is untouched by the redirect.
    expect(payload.html).toContain("This mission was cancelled");
    // The success log records both the real and the intended recipient.
    expect(loggedInfo().message).toContain(
      "Sent email to=dev-inbox@example.test (intended pilot@example.test)",
    );
  });
});

describe("failures are swallowed (best-effort mail)", () => {
  beforeEach(() => {
    env.MAIL_ENABLED = true;
  });

  it("logs and returns when Resend rejects the message", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Invalid `to` field." },
    });

    await expect(sendNewBid({ designer, mission, pilotName: "Pip", amount: 1250 })).resolves.toBe(
      undefined,
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toContain(
      'Failed to send email to=designer@example.test subject="New bid on "Bridge survey""',
    );
  });

  it("logs and returns when the transport itself throws", async () => {
    sendMock.mockRejectedValue(new Error("ECONNRESET"));

    await expect(sendMissionOverdue(pilot, mission)).resolves.toBe(undefined);

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("logs and returns when the client cannot be built (no API key)", async () => {
    env.RESEND_API_KEY = undefined;

    await expect(sendMissionCancelled(pilot, mission)).resolves.toBe(undefined);

    expect(sendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("logs a render failure and never reaches the transport", async () => {
    renderOverride.fn = () => Promise.reject(new Error("template blew up"));

    await expect(sendBidDecision(pilot, mission, "1250.00", true)).resolves.toBe(undefined);

    expect(sendMock).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toContain(
      "Failed to render email template email/bid-accepted for pilot@example.test",
    );
  });

  it("swallows a render failure in the disabled branch too", async () => {
    env.MAIL_ENABLED = false;
    renderOverride.fn = () => Promise.reject(new Error("template blew up"));

    await expect(sendNewBid({ designer, mission, pilotName: "Pip", amount: 1250 })).resolves.toBe(
      undefined,
    );

    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("subject, template and CTA per message", () => {
  beforeEach(() => {
    env.MAIL_ENABLED = true;
  });

  it("sendNewBid → designer, new-bid template, mission CTA", async () => {
    await sendNewBid({
      designer,
      mission,
      pilotName: "Pip",
      amount: "1250.00",
      message: "Happy to fly this on short notice.",
    });

    const { to, subject, html } = sentPayload();
    expect(to).toBe("designer@example.test");
    expect(subject).toBe('New bid on "Bridge survey"');
    expect(html).toContain("You have a new bid");
    expect(html).toContain("Pip");
    expect(html).toContain("1250.00");
    expect(html).toContain("Happy to fly this on short notice.");
    expect(html).toContain('href="https://app.example.test/missions/42"');
  });

  it("sendNewBid → hides the quote block when the bid had no message", async () => {
    await sendNewBid({ designer, mission, pilotName: "Pip", amount: "1250.00" });

    expect(sentPayload().html).not.toContain("“");
  });

  it("sendBidDecision(accepted) → bid-accepted, 'was accepted' subject, mission CTA", async () => {
    await sendBidDecision(pilot, mission, "1250.00", true);

    const { to, subject, html } = sentPayload();
    expect(to).toBe("pilot@example.test");
    expect(subject).toBe('Your bid on "Bridge survey" was accepted');
    expect(html).toContain("Your bid was accepted");
    expect(html).toContain("Your winning bid");
    expect(html).toContain("1250.00");
    expect(html).toContain('href="https://app.example.test/missions/42"');
    expect(html).not.toContain("Browse open missions");
  });

  it("sendBidDecision(rejected) → bid-rejected, 'Update on your bid' subject, browse CTA", async () => {
    await sendBidDecision(pilot, mission, "1250.00", false);

    const { to, subject, html } = sentPayload();
    expect(to).toBe("pilot@example.test");
    expect(subject).toBe('Update on your bid for "Bridge survey"');
    expect(html).toContain("Your bid wasn&#x27;t selected");
    expect(html).toContain("Browse open missions");
    expect(html).toContain('href="https://app.example.test/missions"');
    // Rejected never links to the mission page, and never prints the amount
    // the source still binds into its context.
    expect(html).not.toContain('href="https://app.example.test/missions/42"');
    expect(html).not.toContain("1250.00");
  });

  it("sendMissionOverdue → mission-overdue, 'Has your flight ... ended?' subject", async () => {
    await sendMissionOverdue(pilot, mission);

    const { to, subject, html } = sentPayload();
    expect(to).toBe("pilot@example.test");
    expect(subject).toBe('Has your flight for "Bridge survey" ended?');
    expect(html).toContain("Mark mission finished");
    expect(html).toContain('href="https://app.example.test/missions/42"');
  });

  it("sendMissionCancelled → mission-cancelled, 'was cancelled' subject", async () => {
    await sendMissionCancelled(pilot, mission);

    const { to, subject, html } = sentPayload();
    expect(to).toBe("pilot@example.test");
    expect(subject).toBe('Mission "Bridge survey" was cancelled');
    expect(html).toContain("This mission was cancelled");
    expect(html).toContain('href="https://app.example.test/missions/42"');
  });

  it("builds CTA links off APP_URL, without a doubled slash", async () => {
    env.APP_URL = "https://drone.example.test";

    await sendMissionOverdue(pilot, { id: 7, name: "Roof scan" });

    expect(sentPayload().html).toContain('href="https://drone.example.test/missions/7"');
  });

  it("exposes the same four sends through the injectable `emailService` object", async () => {
    await emailService.sendBidDecision(pilot, mission, "1250.00", true);

    expect(sentPayload().subject).toBe('Your bid on "Bridge survey" was accepted');
    expect(emailService.sendNewBid).toBe(sendNewBid);
    expect(emailService.sendMissionOverdue).toBe(sendMissionOverdue);
    expect(emailService.sendMissionCancelled).toBe(sendMissionCancelled);
  });
});
