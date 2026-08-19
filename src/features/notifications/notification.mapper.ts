import "server-only";
import type { Notification, NotificationResponse } from "./notification.types";

/**
 * Entity -> response DTO mapping (replaces
 * `web.mapper.notification.NotificationMapper.toResponse`).
 *
 * SOURCE: drone-missions-backend/.../web/mapper/notification/NotificationMapper.java
 */

/**
 * Shapes a `notification` row into the public `NotificationResponse`.
 *
 * Two flattenings, both straight from the source mapper:
 * - the mission association becomes a bare id, null-safe
 *   (`getMission() == null ? null : getMission().getId()`); here the FK is
 *   already a scalar column, so the null check is the column's own.
 * - `readAt` becomes the boolean `read` (`getReadAt() != null`); the
 *   timestamp itself is deliberately not exposed.
 */
export function toNotificationResponse(notification: Notification): NotificationResponse {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    missionId: notification.missionId ?? null,
    read: notification.readAt !== null,
    createdAt: notification.createdAt,
  };
}
