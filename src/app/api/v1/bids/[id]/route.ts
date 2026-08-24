import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { withdraw } from "@/features/bids/server/bid.service";

/**
 * `DELETE /api/v1/bids/{id}` — withdraw the calling pilot's pending bid
 * (replaces `BidController.withdraw`).
 *
 * `@PreAuthorize("hasRole('PILOT')")` becomes an explicit `requireRole()`.
 * Ownership is *not* checked here: it is a property of the bid, so it lives in
 * `BidService.withdraw`, the layer that loads the row — and there it surfaces
 * as `BidNotFoundError` -> 404 rather than a 403, so a pilot cannot probe
 * which bid ids exist by reading the status code. A bid that has already been
 * decided is a `BidConflictError` -> 409. `withErrorHandling()` maps both.
 *
 * Answers 204 with no body (`ResponseEntity.noContent()`), because the bid no
 * longer exists to be returned.
 *
 * The sibling `POST /api/v1/bids/{id}/accept` (designer-only) lives in
 * `accept/route.ts`, under this same dynamic segment.
 *
 * SOURCE: drone-missions-backend/.../web/controller/bid/BidController.java (`withdraw`)
 */

/** The dynamic segment this route file owns. */
type BidRouteContext = { params: Promise<{ id: string }> };

/**
 * The path variable, validated the way `@PathVariable Long id` is — the same
 * schema `missions/[id]/route.ts` uses, for the same reasons: Spring answers
 * 400 (`MethodArgumentTypeMismatchException`) for a non-numeric segment, and
 * the safe-integer bound rejects ids a JS number cannot represent exactly
 * (which no `bigint` identity row can have anyway) instead of querying for a
 * silently rounded one.
 */
const bidIdSchema = z.object({
  id: z
    .string()
    .regex(/^-?\d+$/, "must be a number")
    .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
    .transform(Number),
});

export const DELETE = withErrorHandling<BidRouteContext>(async (request, context) => {
  const { id } = bidIdSchema.parse(await context.params);
  const caller = getCurrentUser(request);
  requireRole(caller, "PILOT");

  await withdraw(id, caller.id);
  return new NextResponse(null, { status: 204 });
});
