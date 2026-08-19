import "server-only";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { notification } from "@/db/schema";
import type { NewNotification, Notification, NotificationType } from "./notification.types";

/**
 * Notification persistence (replaces `data.repository.NotificationRepository`).
 *
 * The four derived-query methods of the Spring Data interface map one-to-one
 * onto the first four functions below. The last two replace the `save()`
 * calls the service makes after mutating a loaded entity: JPA's dirty
 * checking has no counterpart here, so the write is expressed as an explicit
 * `UPDATE` instead.
 *
 * SOURCE: drone-missions-backend/.../data/repository/NotificationRepository.java
 */

/**
 * Persists one notification. `id` is DB-generated;
 * `createdAt`/`updatedAt` are stamped here the same way `user.queries.ts`'s
 * `insertUser` stamps them — `V9__create_notification_table.sql` gives
 * neither column a default (the Java side relies on Hibernate's
 * `@CreationTimestamp`/`@UpdateTimestamp`), so the application must set them.
 * `readAt` is left null: unread.
 *
 * Mirrors `NotificationRepository.save` as called by `NotificationService.create`.
 */
export async function insert(newNotification: NewNotification): Promise<Notification> {
  const now = new Date();
  const [row] = await getDb()
    .insert(notification)
    .values({
      userId: newNotification.userId,
      type: newNotification.type,
      title: newNotification.title,
      message: newNotification.message,
      missionId: newNotification.mission?.id ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

/**
 * Mirrors `findByUser_IdOrderByCreatedAtDesc` — one user's notifications,
 * newest first, served by the `idx_notification_user_created` index.
 *
 * Note: `id DESC` is added as a tiebreaker. The source orders by
 * `created_at` alone, which leaves rows sharing a timestamp in an unspecified
 * order; since ids are monotonic, breaking the tie by id keeps "newest first"
 * true (rather than arbitrary) for notifications created inside the same
 * clock tick, without changing the order of any two rows the source already
 * ordered.
 */
export async function listFor(userId: number): Promise<Notification[]> {
  return getDb()
    .select()
    .from(notification)
    .where(eq(notification.userId, userId))
    .orderBy(desc(notification.createdAt), desc(notification.id));
}

/** Mirrors `countByUser_IdAndReadAtIsNull`. */
export async function unreadCount(userId: number): Promise<number> {
  const [row] = await getDb()
    .select({ value: count() })
    .from(notification)
    .where(and(eq(notification.userId, userId), isNull(notification.readAt)));
  return row?.value ?? 0;
}

/**
 * Mirrors `findByIdAndUser_Id` — `undefined` (the source's empty `Optional`)
 * both when no such notification exists and when it belongs to someone else.
 * That conflation is what lets the service mask other users' rows as 404.
 */
export async function findByIdAndUserId(
  id: number,
  userId: number,
): Promise<Notification | undefined> {
  const [row] = await getDb()
    .select()
    .from(notification)
    .where(and(eq(notification.id, id), eq(notification.userId, userId)));
  return row;
}

/**
 * Mirrors `existsByUser_IdAndMission_IdAndType` — guards the overdue
 * scheduler so each mission is notified only once.
 */
export async function existsByUserMissionAndType(
  userId: number,
  missionId: number,
  type: NotificationType,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: notification.id })
    .from(notification)
    .where(
      and(
        eq(notification.userId, userId),
        eq(notification.missionId, missionId),
        eq(notification.type, type),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Stamps `read_at` on one notification. Replaces the `repository.save(...)`
 * that follows `notification.setReadAt(now)` in `NotificationService.markRead`;
 * `updated_at` is bumped alongside it, the way `@UpdateTimestamp` would.
 *
 * The service only calls this for a row it has already loaded and found
 * unread, so the write is unconditional here — matching the source, where the
 * "only if unread" test is likewise the service's.
 */
export async function markReadById(id: number, readAt: Date): Promise<void> {
  await getDb()
    .update(notification)
    .set({ readAt, updatedAt: readAt })
    .where(eq(notification.id, id));
}

/**
 * Stamps `read_at` on every one of a user's *unread* notifications, at a
 * single instant.
 *
 * Replaces `NotificationService.markAllRead`'s load-filter-save loop with the
 * equivalent single `UPDATE`: the `readAt IS NULL` predicate is the same
 * filter the loop applies, so rows already read keep their earlier `readAt`
 * untouched, and every row updated in one call shares one timestamp exactly
 * as the loop's hoisted `Instant now` did.
 */
export async function markAllReadFor(userId: number, readAt: Date): Promise<void> {
  await getDb()
    .update(notification)
    .set({ readAt, updatedAt: readAt })
    .where(and(eq(notification.userId, userId), isNull(notification.readAt)));
}
