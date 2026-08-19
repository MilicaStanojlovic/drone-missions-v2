import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { toBidResponse } from "@/features/bids/bid.mapper";
import { accept } from "@/features/bids/bid.service";
import type { BidResponse } from "@/features/bids/bid.types";

/**
 * `POST /api/v1/bids/{id}/accept` — the designer awards their mission to one
 * bid (replaces `BidController.accept`).
 *
 * `@PreAuthorize("hasRole('DESIGNER')")` becomes an explicit `requireRole()`.
 * It is the only role gate the web layer contributes: *which* designer may
 * award is a property of the mission, not of the endpoint, so the
 * owner check lives in `BidService.accept`, the layer that loads the mission
 * row — and it surfaces there as `MissionAccessDeniedError` -> 403 ahead of
 * both conflict checks, so a designer poking at other people's bid ids never
 * learns from a 409 whether a mission was already awarded.
 *
 * Everything else this handler could be tempted to do is likewise the
 * service's, and reaches the client only as the error `withErrorHandling()`
 * maps: an unknown bid is `BidNotFoundError` -> 404, a bid whose mission has
 * since been deleted `MissionNotFoundError` -> 404, and an already-awarded
 * mission / already-decided bid / suspended pilot `BidConflictError` -> 409.
 * The cascade the call actually performs — losers rejected, mission AWARDED,
 * both pilots notified and emailed — is invisible from here by design: the
 * source returns only the accepted bid, so this responds **200 with the single
 * `BidResponse`** the mapper makes of it, not the mission and not the loser
 * list.
 *
 * There is no request body: the bid id in the path is the whole input, and the
 * awarding designer comes off the headers `middleware.ts` attaches from the
 * verified token's `sub` claim (the analogue of
 * `@AuthenticationPrincipal Long userId`), never from the body or query
 * string, so the award cannot be attributed to another designer.
 *
 * SOURCE: drone-missions-backend/.../web/controller/bid/BidController.java (`accept`)
 */

/** The dynamic segment this route file owns — `bids/[id]`'s, one level up. */
type BidRouteContext = { params: Promise<{ id: string }> };

/**
 * The path variable, validated the way `@PathVariable Long id` is — the same
 * schema the sibling `bids/[id]/route.ts` uses, for the same reasons: Spring
 * answers 400 (`MethodArgumentTypeMismatchException`) for a non-numeric
 * segment, and the safe-integer bound rejects ids a JS number cannot represent
 * exactly (which no `bigint` identity row can have anyway) instead of querying
 * for a silently rounded one. It is re-declared rather than imported because a
 * `route.ts` may only export route handlers.
 */
const bidIdSchema = z.object({
  id: z
    .string()
    .regex(/^-?\d+$/, "must be a number")
    .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
    .transform(Number),
});

export const POST = withErrorHandling<BidRouteContext>(async (request, context) => {
  const { id } = bidIdSchema.parse(await context.params);
  const caller = getCurrentUser(request);
  requireRole(caller, "DESIGNER");

  const bid = await accept(id, caller.id);
  return NextResponse.json<BidResponse>(toBidResponse(bid));
});
