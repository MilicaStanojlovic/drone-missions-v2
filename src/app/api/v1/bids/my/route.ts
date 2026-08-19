import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { toBidResponse } from "@/features/bids/bid.mapper";
import { myBids } from "@/features/bids/bid.service";
import type { BidResponse } from "@/features/bids/bid.types";

/**
 * `GET /api/v1/bids/my` — every bid the calling pilot has placed, newest
 * first, with their current statuses (replaces `BidController.myBids`).
 *
 * `@PreAuthorize("hasRole('PILOT')")` becomes an explicit `requireRole()`:
 * unlike `GET /api/v1/missions/my-missions`, whose source guard is only
 * `isAuthenticated()`, this endpoint is pilot-only in the source, so a
 * designer gets a 403 here rather than an empty list. The distinction is the
 * source's and is preserved rather than smoothed over.
 *
 * The pilot id comes off the headers `middleware.ts` attaches from the
 * verified token's `sub` claim (the analogue of
 * `@AuthenticationPrincipal Long userId`) and is never read from the query
 * string, so this endpoint cannot be pointed at another pilot's bids.
 *
 * This is the `/my-bids` page's data source; the file lives beside
 * `bids/[id]/route.ts`, and the static `my` segment wins over the dynamic one
 * in Next.js route matching, exactly as Spring matches the literal `/my`
 * mapping ahead of `/{id}`.
 *
 * SOURCE: drone-missions-backend/.../web/controller/bid/BidController.java (`myBids`)
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  requireRole(caller, "PILOT");

  const bids = await myBids(caller.id);
  return NextResponse.json<BidResponse[]>(bids.map(toBidResponse));
});
