import "server-only";

/**
 * The parameter shapes the mail port speaks (replaces the Java signatures'
 * `User` / `Mission` JPA entities and the `NewBidEmail` record).
 *
 * Deliberate migration decision: where `EmailService.java` takes whole
 * `User` and `Mission` **entities**, this port takes small **plain objects**
 * carrying only the fields the emails actually read — recipient
 * `{email, username}`, mission `{id, name, location}`. Two reasons:
 *  - `src/lib/email` is shared infrastructure (`lib/`, not a feature). Typing
 *    it against `features/missions` would make a shared module depend on a
 *    feature module, and the missions feature does not exist yet — Phase 5's
 *    bid/lifecycle code must be able to call this without one.
 *  - Callers stay free to pass a Drizzle `mission` row, a mapped response
 *    object, or a literal — anything structurally compatible.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/mail/EmailService.java (method signatures, `baseContext`)
 * - drone-missions-backend/.../business/service/mail/NewBidEmail.java
 */

/**
 * Whoever the message is addressed to — the mission's designer for
 * `sendNewBid`, the pilot for the other three. `username` is what
 * `baseContext` binds as the templates' `recipientName`
 * (`recipient.getUsername()`), `email` is the envelope recipient
 * (`designer.getEmail()` / `pilot.getEmail()`).
 */
export interface EmailRecipient {
  email: string;
  username: string;
}

/**
 * The mission the message is about. `id` builds the CTA link
 * (`missionUrl(mission.getId())`), `name` goes into both the subject and the
 * body copy.
 *
 * `location` mirrors `baseContext`'s `missionLocation` binding and is
 * optional-and-nullable because the column is (`Mission.location` has no
 * `nullable = false`; `MissionRequest.location` is only `@Size(max = 255)`,
 * unlike the `@NotBlank` `name`). Discrepancy worth recording: the source
 * binds `missionLocation` into every one of the five contexts, but *no*
 * template under `templates/email/` references it — verified by grep. It is
 * accepted here for signature parity and to keep the port honest if a
 * template ever starts rendering it, and is currently passed to no template.
 */
export interface EmailMission {
  id: number;
  name: string;
  location?: string | null;
}

/**
 * A bid amount as the templates print it — straight after a `$`, exactly the
 * way Thymeleaf printed the `BigDecimal`. `string` is the shape a Drizzle
 * `numeric` column yields (JS `number` cannot hold arbitrary-precision
 * decimals safely), `number` is accepted for literals and tests.
 */
export type EmailAmount = string | number;

/**
 * Everything the "new bid" email needs — the direct port of the
 * `NewBidEmail` record, kept as a parameter object for the same reason the
 * source gives: `pilotName` and `message` are both strings and would be
 * swappable as positional arguments without the compiler noticing.
 */
export interface NewBidEmailInput {
  /** The mission's owner, who receives the email. */
  designer: EmailRecipient;
  /** The mission that was bid on. */
  mission: EmailMission;
  /** Display name of the bidding pilot. */
  pilotName: string;
  /** The bid amount. */
  amount: EmailAmount;
  /** The pilot's covering message; may be null/omitted (`th:if="${bidMessage}"`). */
  message?: string | null;
}

/**
 * The mail port itself — the four sends `EmailService.java` exposes.
 *
 * Every method resolves to `void` and **never rejects**: mail is best-effort
 * (render and transport failures are caught and logged), which is this
 * port's analogue of the source's `@Async void` methods that "never propagate
 * a failure back to the triggering action (a bid, a scheduled sweep)".
 * Callers may therefore `await` them or drop them with `void
 * emailService.sendNewBid(...)` — neither can break the flow that triggered
 * the mail.
 */
export interface EmailService {
  /** Tell a mission's owner that a pilot has placed a bid on it. */
  sendNewBid(email: NewBidEmailInput): Promise<void>;
  /** Notify the pilot that their bid was accepted or rejected. */
  sendBidDecision(
    pilot: EmailRecipient,
    mission: EmailMission,
    amount: EmailAmount,
    accepted: boolean,
  ): Promise<void>;
  /** Ask the winning pilot whether the flight has ended (mission past its end date). */
  sendMissionOverdue(pilot: EmailRecipient, mission: EmailMission): Promise<void>;
  /** Tell the awarded pilot that the designer cancelled the mission they had won. */
  sendMissionCancelled(pilot: EmailRecipient, mission: EmailMission): Promise<void>;
}
