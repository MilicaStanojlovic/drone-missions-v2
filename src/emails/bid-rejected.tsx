import { EmailButton, EmailLayout, EmailParagraph, emailColors } from "./layout";

export interface BidRejectedEmailProps {
  /** Losing pilot's display name. */
  recipientName: string;
  missionName: string;
  /** `${APP_URL}/missions` — the browse list, not the mission page. */
  ctaUrl: string;
}

/**
 * "Update on your bid" — sent to every pilot whose bid was not selected.
 *
 * Note the deliberate mismatch carried over from the source: the accent stripe
 * and eyebrow are grey (`#93a1b0`) while the CTA stays brand blue (`#2f6bff`),
 * unlike the other four templates where CTA and accent share one colour. No
 * amount panel here either — `sendBidDecision` still binds `amount`, but the
 * rejected template never renders it.
 *
 * SOURCE: drone-missions-backend/.../resources/templates/email/bid-rejected.html
 * (variables bound in `EmailService.sendBidDecision(..., accepted = false)`).
 */
export function BidRejectedEmail({ recipientName, missionName, ctaUrl }: BidRejectedEmailProps) {
  return (
    <EmailLayout
      title="Update on your bid"
      accentColor={emailColors.neutral}
      eyebrow="Bid update"
      heading="Your bid wasn't selected"
      footer={
        "DroneMissions — the drone mission marketplace. " +
        "You're receiving this because you bid on this mission."
      }
    >
      <EmailParagraph>
        Hi <strong>{recipientName}</strong>, the designer awarded <strong>{missionName}</strong> to
        another pilot this time. Thanks for bidding — there are always more missions to fly.
      </EmailParagraph>
      <EmailButton href={ctaUrl} background={emailColors.primary}>
        Browse open missions →
      </EmailButton>
    </EmailLayout>
  );
}

export default BidRejectedEmail;
