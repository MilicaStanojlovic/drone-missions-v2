import { EmailAmountBox, EmailButton, EmailLayout, EmailParagraph, emailColors } from "./layout";

export interface NewBidEmailProps {
  /** Mission owner's display name (`recipientName` — `User.getUsername()` in the source). */
  recipientName: string;
  /** Display name of the bidding pilot. */
  pilotName: string;
  missionName: string;
  /** Printed verbatim after "$", as Thymeleaf printed the `BigDecimal`. */
  amount: string | number;
  /** The pilot's covering message. Optional in the source (`th:if="${bidMessage}"`). */
  bidMessage?: string | null;
  /** `${APP_URL}/missions/{id}`. */
  ctaUrl: string;
}

/**
 * "New bid on your mission" — sent to a mission's designer when a pilot bids.
 *
 * SOURCE: drone-missions-backend/.../resources/templates/email/new-bid.html
 * (variables bound in `EmailService.sendNewBid`).
 */
export function NewBidEmail({
  recipientName,
  pilotName,
  missionName,
  amount,
  bidMessage,
  ctaUrl,
}: NewBidEmailProps) {
  return (
    <EmailLayout
      title="New bid on your mission"
      accentColor={emailColors.primary}
      eyebrow="New bid"
      heading="You have a new bid"
      footer={
        "DroneMissions — the drone mission marketplace. " +
        "You're receiving this because someone bid on a mission you created."
      }
    >
      <EmailParagraph>
        Hi <strong>{recipientName}</strong>, <strong>{pilotName}</strong> placed a bid on your
        mission <strong>{missionName}</strong>.
      </EmailParagraph>
      <EmailAmountBox
        label="Bid amount"
        amount={amount}
        background="#f7f9fb"
        borderColor={emailColors.cardBorder}
        labelColor="#a2afbc"
        amountColor={emailColors.text}
        quote={bidMessage ? bidMessage : undefined}
      />
      <EmailButton href={ctaUrl} background={emailColors.primary}>
        Review the bid →
      </EmailButton>
    </EmailLayout>
  );
}

export default NewBidEmail;
