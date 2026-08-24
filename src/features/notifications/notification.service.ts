import "server-only";
import { NotFoundError } from "@/lib/errors";
import * as queries from "@/features/notifications/notification.queries";
import type { NewNotification, Notification } from "@/features/notifications/notification.types";

/**
 * In-app notification service (replaces
 * `business.service.notification.NotificationService`).
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/notification/NotificationService.java
 * - drone-missions-backend/.../business/exception/notification/NotificationNotFoundException.java
 */

/**
 * Thrown when a notification cannot be found by id for the current user —
 * including when it belongs to someone else, masked as not-found so ids
 * can't be probed (the source's stated reason, mirroring the bid/mission
 * pattern). Mapped to 404 by `withErrorHandling()`.
 *
 * Declared beside the code that throws it, following the `UserNotFoundError`
 * precedent in `user.queries.ts`; here the throw site is the service, since
 * that is where the source raises it.
 *
 * SOURCE: `NotificationNotFoundException`
 */
export class NotificationNotFoundError extends NotFoundError {
  constructor(id: number) {
    super(`Notification ${id} not found`);
  }
}

/** Create and persist a notification for a user. */
export async function create(request: NewNotification): Promise<Notification> {
  return queries.insert(request);
}

/** The caller's notifications, newest first. */
export async function listFor(userId: number): Promise<Notification[]> {
  return queries.listFor(userId);
}

/** How many of the caller's notifications are unread. */
export async function unreadCount(userId: number): Promise<number> {
  return queries.unreadCount(userId);
}

/**
 * Mark one of the caller's notifications read (idempotent — a second call on
 * an already-read notification leaves the original `readAt` alone, exactly
 * like the source's `if (getReadAt() == null)` guard).
 *
 * @throws NotificationNotFoundError if no notification with that id belongs
 * to this user — whether it does not exist or belongs to someone else.
 */
export async function markRead(id: number, userId: number): Promise<void> {
  const notification = await queries.findByIdAndUserId(id, userId);
  if (!notification) {
    throw new NotificationNotFoundError(id);
  }
  if (notification.readAt === null) {
    await queries.markReadById(id, new Date());
  }
}

/** Mark all of the caller's unread notifications read. */
export async function markAllRead(userId: number): Promise<void> {
  await queries.markAllReadFor(userId, new Date());
}

/** Whether an overdue notification already exists for this pilot + mission (dedup). */
export async function overdueExists(userId: number, missionId: number): Promise<boolean> {
  return queries.existsByUserMissionAndType(userId, missionId, "MISSION_OVERDUE");
}
