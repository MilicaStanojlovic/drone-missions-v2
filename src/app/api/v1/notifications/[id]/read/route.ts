import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/guards";
import { markRead } from "@/features/notifications/notification.service";

/**
 * `POST /api/v1/notifications/{id}/read` — mark one notification read
 * (replaces `NotificationController.markRead`).
 *
 * Authenticated-only: this path is not in `src/middleware.ts`'s
 * `PUBLIC_PATHS`, so an anonymous request is already rejected with 401
 * before this handler ever runs — mirroring `@PreAuthorize("isAuthenticated()")`.
 *
 * Ownership is enforced one layer down, exactly as in the source: the
 * service looks the notification up by *id and caller id* together, so
 * another user's (or a non-existent) id raises `NotificationNotFoundError`
 * -> 404 via `withErrorHandling()`, never a 403 that would confirm the row
 * exists. The handler stays a thin parse -> service -> status shell.
 *
 * Returns 204 with an empty body (`ResponseEntity.noContent()`), and is
 * idempotent — re-marking an already-read notification is also a 204.
 *
 * SOURCE: drone-missions-backend/.../web/controller/notification/NotificationController.java (`markRead`)
 */

/**
 * The `{id}` path segment, mirroring `@PathVariable Long id`: Spring's
 * `Long` converter takes an optionally-signed run of digits and rejects
 * anything else with a 400 (`handleTypeMismatch`), so this does the same —
 * as a Zod schema, which is how `withErrorHandling()` (see its doc comment)
 * turns a bad path/query parameter into a 400 in this port.
 *
 * `Number.isSafeInteger` additionally rejects values past 2^53, which a Java
 * `Long` could carry but a JS `number` cannot represent without silently
 * losing precision — a 400 rather than a lookup for the wrong id.
 */
const readParamsSchema = z.object({
  id: z
    .string()
    .regex(/^[+-]?\d+$/, "Invalid value for parameter 'id'")
    .transform(Number)
    .refine(Number.isSafeInteger, "Invalid value for parameter 'id'"),
});

export const POST = withErrorHandling<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const caller = getCurrentUser(request);
    const { id } = readParamsSchema.parse(await context.params);
    await markRead(id, caller.id);
    return new NextResponse(null, { status: 204 });
  },
);
