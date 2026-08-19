import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/guards";
import { unreadCount } from "@/features/notifications/notification.service";

/**
 * `GET /api/v1/notifications/unread-count` — the caller's unread count, for
 * the bell badge (replaces `NotificationController.unreadCount`).
 *
 * Authenticated-only: this path is not in `src/middleware.ts`'s
 * `PUBLIC_PATHS`, so an anonymous request is already rejected with 401
 * before this handler ever runs — mirroring `@PreAuthorize("isAuthenticated()")`.
 *
 * The body is the single-entry object `{ "count": <n> }`, exactly what the
 * source's `Map.of("count", ...)` serializes to — not a bare number, and not
 * wrapped in a DTO. The Angular bell reads `.count` off it (see
 * `<frontend>/src/app/services/notification.service.ts`), so the envelope
 * has to stay literal.
 *
 * SOURCE: drone-missions-backend/.../web/controller/notification/NotificationController.java (`unreadCount`)
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  const count = await unreadCount(caller.id);
  return NextResponse.json<{ count: number }>({ count }, { status: 200 });
});
