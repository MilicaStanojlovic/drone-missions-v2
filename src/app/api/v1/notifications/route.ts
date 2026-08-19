import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/guards";
import { listFor } from "@/features/notifications/notification.service";
import { toNotificationResponse } from "@/features/notifications/notification.mapper";
import type { NotificationResponse } from "@/features/notifications/notification.types";

/**
 * `GET /api/v1/notifications` — the caller's notifications, newest first
 * (replaces `NotificationController.list`).
 *
 * Authenticated-only: this path is not in `src/middleware.ts`'s
 * `PUBLIC_PATHS`, so an anonymous request is already rejected with 401
 * before this handler ever runs — mirroring `@PreAuthorize("isAuthenticated()")`.
 * The caller id comes off the request headers `middleware.ts` attaches from
 * the verified token's `sub` claim — the Next.js analogue of
 * `@AuthenticationPrincipal Long userId`.
 *
 * No role check: the source deliberately guards this with
 * `isAuthenticated()` rather than `hasRole('PILOT')`, even though only
 * pilots are notified today, so the handler stays role-agnostic too. The
 * scoping is by caller id in the query, not by role.
 *
 * SOURCE: drone-missions-backend/.../web/controller/notification/NotificationController.java (`list`)
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  const notifications = await listFor(caller.id);
  return NextResponse.json<NotificationResponse[]>(notifications.map(toNotificationResponse), {
    status: 200,
  });
});
