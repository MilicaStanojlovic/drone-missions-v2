import { EmailButton, EmailLayout, EmailParagraph, emailColors } from "./layout";

export interface MissionOverdueEmailProps {
  /** Flying pilot's display name. */
  recipientName: string;
  missionName: string;
  /** `${APP_URL}/missions/{id}`. */
  ctaUrl: string;
}

/**
 * "Has your flight ended?" — nudge sent to the flying pilot once a mission has
 * passed its scheduled end date (the scheduled sweep's email).
 *
 * SOURCE: drone-missions-backend/.../resources/templates/email/mission-overdue.html
 * (variables bound in `EmailService.sendMissionOverdue`).
 */
export function MissionOverdueEmail({
  recipientName,
  missionName,
  ctaUrl,
}: MissionOverdueEmailProps) {
  return (
    <EmailLayout
      title="Has your flight ended?"
      accentColor={emailColors.warning}
      eyebrow="Flight check"
      heading="Has your flight ended?"
      footer={
        "DroneMissions — the drone mission marketplace. " +
        "You're receiving this because you're flying this mission."
      }
    >
      <EmailParagraph>
        Hi <strong>{recipientName}</strong>, your mission <strong>{missionName}</strong> has passed
        its scheduled end date. If the flight is done, mark it finished so the designer knows
        it&apos;s complete.
      </EmailParagraph>
      <EmailButton href={ctaUrl} background={emailColors.warning}>
        Mark mission finished →
      </EmailButton>
    </EmailLayout>
  );
}

export default MissionOverdueEmail;
