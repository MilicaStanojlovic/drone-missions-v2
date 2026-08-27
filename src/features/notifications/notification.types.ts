import "server-only";
import type { notification, NotificationType } from "@/db/schema";

/**
 * Notification domain types (replaces `data.model.Notification`, the
 * business-layer value object `business.service.notification.NewNotification`
 * and the web DTO `web.dto.notification.NotificationResponse`).
 *
 * `NotificationType` itself is not redeclared here — it already lives in
 * `src/db/schema.ts` as the union backing the `notification_type_check`
 * constraint (the counterpart of the Java `NotificationType` enum), and is
 * re-exported below so callers can take the whole notification vocabulary
 * from one module.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/model/Notification.java
 * - drone-missions-backend/.../data/model/NotificationType.java
 * - drone-missions-backend/.../business/service/notification/NewNotification.java
 * - drone-missions-backend/.../web/dto/notification/NotificationResponse.java
 */

export type { NotificationType };

/** The full `notification` row, exactly as stored. */
export type Notification = typeof notification.$inferSelect;

/**
 * The mission a notification is about, reduced to the fields the
 * notification actually reads.
 *
 * Deliberate migration decision, mirroring the one already taken for the
 * mail port (`src/lib/email/email.types.ts`): where `NewNotification.java`
 * carries a whole `Mission` **entity**, this carries a plain object with
 * only `id` (persisted as `notification.mission_id`, and echoed back as
 * `NotificationResponse.missionId`) and `name` (interpolated into the
 * message copy). Phase 5's bid/lifecycle code must be able to raise
 * notifications before a missions feature module exists, and callers stay
 * free to pass a Drizzle `mission` row — anything structurally compatible.
 */
export interface NotificationMission {
  id: number;
  name: string;
}

/**
 * The data needed to raise one in-app notification — the port of the
 * `NewNotification` record. A parameter object rather than five positional
 * arguments, for the same reason the source gives: the two ids and the two
 * strings could otherwise be transposed at a call site unnoticed.
 *
 * The record's `Objects.requireNonNull(userId)` / `requireNonNull(type)`
 * compact-constructor guards are expressed by the non-optional types here —
 * both fields are required, and `mission` is the only nullable one (the
 * `mission_id` column is nullable, for notifications not about a mission).
 *
 * A business-layer value object, not a web DTO — deliberately not shaped
 * like `NotificationResponse`, exactly as the source keeps it out of
 * `web.dto`.
 */
export interface NewNotification {
  userId: number;
  type: NotificationType;
  title: string;
  message: string;
  mission?: NotificationMission | null;
}

/**
 * The wording of each notification type, in exactly one place — the port of
 * `NewNotification`'s static factories. They exist so the copy is not
 * rebuilt inline by the bid, mission-lifecycle and overdue-sweep callers
 * that land in later phases.
 *
 * Declared as a `const` object sharing the `NewNotification` name (TypeScript
 * merges the type and value namespaces) so call sites read
 * `NewNotification.bidAccepted(pilotId, mission)`, character-for-character
 * the Java call.
 */
export const NewNotification = {
  /** The pilot won: their bid was accepted and the mission is theirs. */
  bidAccepted(pilotId: number, mission: NotificationMission): NewNotification {
    return {
      userId: pilotId,
      type: "BID_ACCEPTED",
      title: "Bid accepted",
      message: `Your bid on "${mission.name}" was accepted — the mission is yours.`,
      mission,
    };
  },

  /** The pilot lost: another bid was chosen for this mission. */
  bidRejected(pilotId: number, mission: NotificationMission): NewNotification {
    return {
      userId: pilotId,
      type: "BID_REJECTED",
      title: "Bid not selected",
      message: `Your bid on "${mission.name}" wasn't selected.`,
      mission,
    };
  },

  /** The designer cancelled a mission this pilot had already won. */
  missionCancelled(pilotId: number, mission: NotificationMission): NewNotification {
    return {
      userId: pilotId,
      type: "MISSION_CANCELLED",
      title: "Mission cancelled",
      message: `"${mission.name}" was cancelled by the designer.`,
      mission,
    };
  },

  /**
   * A pilot bid on this designer's mission.
   *
   * The only factory here that targets a DESIGNER rather than a pilot, and the
   * only one with no counterpart in the source: `BidService.place` tells the
   * designer by email (`sendNewBid`) and raises no in-app notification, so
   * there is no `NewNotification.newBid` in the Java record.
   *
   * The wording deliberately mirrors `src/emails/new-bid.tsx` so the two
   * channels read alike — the email's eyebrow is the title, its heading
   * sentence the message. The bid amount is left out: the email renders it
   * through a formatted currency component and this app has no currency
   * formatter, so interpolating a bare number here would invent a format.
   */
  newBid(designerId: number, mission: NotificationMission, pilotName: string): NewNotification {
    return {
      userId: designerId,
      type: "NEW_BID",
      title: "New bid",
      message: `${pilotName} placed a bid on "${mission.name}".`,
      mission,
    };
  },

  /** The awarded mission's flight window has passed without being marked finished. */
  missionOverdue(pilotId: number, mission: NotificationMission): NewNotification {
    return {
      userId: pilotId,
      type: "MISSION_OVERDUE",
      title: "Has your flight ended?",
      message: `"${mission.name}" has passed its end date. Mark it finished if the flight is done.`,
      mission,
    };
  },
} as const;

/**
 * Public view of one notification. Mirrors `NotificationResponse`
 * field-for-field, including the flattening of the two entity associations:
 * the mission becomes a bare `missionId` (null when there is no mission) and
 * `readAt` becomes the boolean `read`. `readAt` itself is never exposed —
 * the source's DTO does not carry it.
 */
export interface NotificationResponse {
  id: number;
  type: NotificationType;
  title: string;
  message: string;
  missionId: number | null;
  read: boolean;
  createdAt: Date;
}
