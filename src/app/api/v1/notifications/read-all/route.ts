import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/guards";
import { markAllRead } from "@/features/notifications/notification.service";

/**
 * `POST /api/v1/notifications/read-all` — mark all of the caller's
 * notifications read (replaces `NotificationController.markAllRead`).
 *
 * Authenticated-only: this path is not in `src/middleware.ts`'s
 * `PUBLIC_PATHS`, so an anonymous request is already rejected with 401
 * before this handler ever runs — mirroring `@PreAuthorize("isAuthenticated()")`.
 *
 * The static `read-all` segment is declared as its own route file so it wins
 * over the sibling `[id]` dynamic segment — Next.js matches static segments
 * before dynamic ones, the same way Spring's `@PostMapping("/read-all")`
 * takes precedence over `@PostMapping("/{id}/read")`. (The two never
 * actually collide here: `[id]` only serves `/{id}/read`, one segment
 * deeper.)
 *
 * Returns 204 with an empty body (`ResponseEntity.noContent()`); marking
 * nothing (no unread rows) is still a 204.
 *
 * SOURCE: drone-missions-backend/.../web/controller/notification/NotificationController.java (`markAllRead`)
 */
export const POST = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  await markAllRead(caller.id);
  return new NextResponse(null, { status: 204 });
});
