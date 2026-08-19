import { EmailButton, EmailLayout, EmailParagraph, emailColors } from "./layout";

export interface MissionCancelledEmailProps {
  /** Awarded pilot's display name. */
  recipientName: string;
  missionName: string;
  /** `${APP_URL}/missions/{id}`. */
  ctaUrl: string;
}

/**
 * "Mission cancelled" — sent to the pilot who had won a mission the designer
 * then cancelled.
 *
 * SOURCE: drone-missions-backend/.../resources/templates/email/mission-cancelled.html
 * (variables bound in `EmailService.sendMissionCancelled`).
 */
export function MissionCancelledEmail({
  recipientName,
  missionName,
  ctaUrl,
}: MissionCancelledEmailProps) {
  return (
    <EmailLayout
      title="Mission cancelled"
      accentColor={emailColors.danger}
      eyebrow="Mission update"
      heading="This mission was cancelled"
      footer={
        "DroneMissions — the drone mission marketplace. " +
        "You're receiving this because this mission had been awarded to you."
      }
    >
      <EmailParagraph>
        Hi <strong>{recipientName}</strong>, the designer has cancelled the mission{" "}
        <strong>{missionName}</strong>, which had been awarded to you. No further action is needed —
        the job is no longer active.
      </EmailParagraph>
      <EmailButton href={ctaUrl} background={emailColors.danger}>
        View the mission →
      </EmailButton>
    </EmailLayout>
  );
}

export default MissionCancelledEmail;
