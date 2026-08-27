"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, getRole, isLoggedIn } from "@/features/auth/auth.client";
import type { NotificationType } from "@/db/schema";

/**
 * Client-side notifications state: the pilot's in-app notification list, its
 * derived unread count, and the mark-read mutations. Replaces
 * `services/notification.service.ts` and `models/notification.model.ts`.
 *
 * The Angular original is a `providedIn: 'root'` singleton holding a
 * `BehaviorSubject` and subscribing to `AuthService.profile$` so it can start
 * polling on sign-in and clear itself on sign-out. There is no DI-singleton
 * layer in this stack, so the same lifecycle is expressed as a hook owned by
 * the one component that consumes it (`components/notification-bell.tsx`):
 * mount = the profile arrived, unmount = signed out or left the authenticated
 * shell, and the effect cleanup is what `stopPolling()` did. The source's
 * pilot-only gate survives as `canReceiveNotifications()` below — widened to
 * designers, who now receive NEW_BID — checked both before the first load and
 * inside every poll tick, exactly as `refresh()` does in the source.
 *
 * `import type` for `NotificationType` is erased at compile time, so this
 * module never pulls `@/db/schema` (and `drizzle-orm/pg-core`) into the client
 * bundle — the same trick `auth.client.ts` uses for `UserRole`. It is also why
 * this file exists at all rather than the component importing
 * `notification.types.ts`, which is `import "server-only"`.
 *
 * SOURCE:
 * - drone-missions-frontend/.../services/notification.service.ts
 * - drone-missions-frontend/.../models/notification.model.ts
 */

/**
 * Notification vocabulary, re-exported from the schema so client code takes
 * the whole notification type set from one module — the counterpart of the
 * source model file declaring its own `NotificationType` union.
 *
 * The source union lists only the three types that existed when the Angular
 * client was written (`BID_ACCEPTED | BID_REJECTED | MISSION_OVERDUE`); the
 * backend's V10 migration widened the column with `MISSION_CANCELLED`, which
 * the server-side port already carries, so the client union follows the
 * database rather than the stale front-end copy.
 */
export type { NotificationType };

/**
 * Accent colour per type — matches the mission/email palette. Mirrors
 * `NOTIFICATION_COLORS` (models/notification.model.ts).
 *
 * `MISSION_CANCELLED` has no entry in the source map (see above) and no
 * dedicated swatch on the design canvas either; it takes the canvas's
 * cancelled-mission red `#e04a3f` (`design/DroneMissions.dc.html`'s status
 * map, `cancelled:{label:'Cancelled',color:'#e04a3f'}`, which the Angular
 * `MISSION_STATUS_COLORS` also uses) so the dot reads the same as the
 * cancelled status chip everywhere else in the app.
 */
export const NOTIFICATION_COLORS: Record<NotificationType, string> = {
  BID_ACCEPTED: "#12a06a",
  BID_REJECTED: "#e04a3f",
  MISSION_OVERDUE: "#d9860a",
  MISSION_CANCELLED: "#e04a3f",
  // Not in the source map either — NEW_BID is this port's addition. It takes
  // the canvas primary / designer role accent (`--role-designer`), since the
  // designer is the only recipient.
  NEW_BID: "#2f6bff",
};

/**
 * One notification as the API returns it — `NotificationResponse` after JSON
 * serialisation, so `createdAt` is an ISO-8601 string rather than a `Date`.
 * Named `AppNotification` for the same reason the source does: to avoid
 * clashing with the browser's global `Notification`.
 */
export interface AppNotification {
  id: number;
  type: NotificationType;
  title: string;
  message: string;
  missionId: number | null;
  read: boolean;
  /** ISO-8601 string. */
  createdAt: string;
}

/** Poll interval while a pilot is signed in. Mirrors `NotificationService.pollMs`. */
const POLL_MS = 45_000;

/**
 * Base path of the notification API. The Angular service hard-codes the
 * separate backend origin (`http://localhost:8085/api/v1/notifications`);
 * this app serves its API from its own origin, so the path is relative.
 */
const BASE_URL = "/api/v1/notifications";

/**
 * Whether the current session belongs to someone who can hold notifications.
 *
 * A considered divergence from the source, not a port: `AuthService.isPilot`
 * gates the Angular service (`this.role === 'PILOT'`) because every one of the
 * four source notification types targets a pilot. This port adds NEW_BID for
 * designers, so the gate widens to both roles.
 *
 * Deliberately NOT a bare `isLoggedIn()`: nothing targets an ADMIN, so an
 * admin session would poll every 45s forever for a list that is always empty.
 * The truthiness half of the source's `profile$` check is kept as `isLoggedIn`.
 */
function canReceiveNotifications(): boolean {
  if (!isLoggedIn()) {
    return false;
  }
  const role = getRole();
  return role === "PILOT" || role === "DESIGNER";
}

/** What {@link useNotifications} hands its consumer. */
export interface UseNotifications {
  /** The caller's notifications, newest first (server order, preserved). */
  notifications: AppNotification[];
  /** Derived from the list, exactly like the source's `unreadCount$`. */
  unreadCount: number;
  /** Re-fetch the caller's notifications. */
  refresh: () => void;
  /** Mark one notification read (optimistically). */
  markRead: (id: number) => void;
  /** Mark every notification read. */
  markAllRead: () => void;
}

/**
 * Loads and polls the signed-in pilot's or designer's notifications.
 *
 * Lifecycle parity with the source: the list is fetched once when such a
 * profile is present and re-fetched every 45s; any other (or signed-out)
 * session holds an empty list and never polls, which is the
 * `subject.next([])` + `stopPolling()` branch of the source's `profile$`
 * subscription. See {@link canReceiveNotifications} for why an admin falls in
 * the second group.
 */
export function useNotifications(): UseNotifications {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  // Derived, not stored — the source computes `unreadCount$` off the list
  // rather than calling `GET /unread-count`, so the badge can drop the moment
  // an optimistic `markRead` lands without waiting for a round trip. (The
  // `/unread-count` endpoint is ported for API parity but is unused here, as
  // in the source.)
  const unreadCount = notifications.filter((n) => !n.read).length;

  const refresh = useCallback(() => {
    if (!canReceiveNotifications()) {
      return;
    }
    apiFetch(BASE_URL)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        setNotifications((await response.json()) as AppNotification[]);
      })
      .catch((error: unknown) => {
        console.error("Failed to load notifications", error);
      });
  }, []);

  useEffect(() => {
    if (!canReceiveNotifications()) {
      setNotifications([]);
      return;
    }
    refresh();
    const handle = setInterval(refresh, POLL_MS);
    return () => clearInterval(handle);
  }, [refresh]);

  /**
   * Marks one notification read.
   *
   * Applied optimistically and rolled back if the request fails, where the
   * source applies it in the success callback. The end state matches either
   * way (success → read, failure → still unread); the difference matters
   * because selecting a row also closes the panel and navigates away, and the
   * badge must not keep counting a row the user has just opened while the
   * POST is in flight.
   */
  const markRead = useCallback((id: number) => {
    setNotifications((current) => current.map((n) => (n.id === id ? { ...n, read: true } : n)));

    apiFetch(`${BASE_URL}/${id}/read`, { method: "POST" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to mark notification read", error);
        // Revert just this row rather than restoring a whole snapshot, so a
        // poll that landed in the meantime is not clobbered.
        setNotifications((current) =>
          current.map((n) => (n.id === id ? { ...n, read: false } : n)),
        );
      });
  }, []);

  /**
   * Marks every notification read. Applied on success, as the source does —
   * unlike a row click this leaves the panel open, so there is nothing to
   * race and no reason to diverge.
   */
  const markAllRead = useCallback(() => {
    apiFetch(`${BASE_URL}/read-all`, { method: "POST" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        setNotifications((current) => current.map((n) => ({ ...n, read: true })));
      })
      .catch((error: unknown) => {
        console.error("Failed to mark all read", error);
      });
  }, []);

  return { notifications, unreadCount, refresh, markRead, markAllRead };
}
