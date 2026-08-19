import { EmailAmountBox, EmailButton, EmailLayout, EmailParagraph, emailColors } from "./layout";

export interface BidAcceptedEmailProps {
  /** Winning pilot's display name. */
  recipientName: string;
  missionName: string;
  /** Printed verbatim after "$", as Thymeleaf printed the `BigDecimal`. */
  amount: string | number;
  /** `${APP_URL}/missions/{id}`. */
  ctaUrl: string;
}

/**
 * "Your bid was accepted" — sent to the pilot whose bid the designer awarded.
 *
 * SOURCE: drone-missions-backend/.../resources/templates/email/bid-accepted.html
 * (variables bound in `EmailService.sendBidDecision(..., accepted = true)`).
 */
export function BidAcceptedEmail({
  recipientName,
  missionName,
  amount,
  ctaUrl,
}: BidAcceptedEmailProps) {
  return (
    <EmailLayout
      title="Your bid was accepted"
      accentColor={emailColors.success}
      eyebrow="Bid accepted"
      heading="Your bid was accepted 🎉"
      footer={
        "DroneMissions — the drone mission marketplace. When the mission's start date arrives " +
        "you'll be able to mark it finished from its page."
      }
    >
      <EmailParagraph>
        Hi <strong>{recipientName}</strong>, your bid on <strong>{missionName}</strong> was accepted
        — the mission is yours.
      </EmailParagraph>
      <EmailAmountBox
        label="Your winning bid"
        amount={amount}
        background="#eef8f2"
        borderColor="#cbe9d8"
        labelColor="#7aa890"
        amountColor="#12704b"
      />
      <EmailButton href={ctaUrl} background={emailColors.success}>
        View the mission →
      </EmailButton>
    </EmailLayout>
  );
}

export default BidAcceptedEmail;
