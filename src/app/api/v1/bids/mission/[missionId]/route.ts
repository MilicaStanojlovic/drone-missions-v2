import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { toBidResponse } from "@/features/bids/server/bid.mapper";
import { bidRequestSchema } from "@/features/bids/server/bid.schema";
import { listForMission, place } from "@/features/bids/server/bid.service";
import type { BidResponse } from "@/features/bids/bid.types";

/**
 * `POST` / `GET /api/v1/bids/mission/{missionId}` (replace
 * `BidController.place` and `BidController.listForMission`).
 *
 * The two verbs are guarded differently, exactly as in the source:
 *
 * - `POST` is `@PreAuthorize("hasRole('PILOT')")` — only a pilot may make an
 *   offer — so it carries an explicit `requireRole()` call.
 * - `GET` is `@PreAuthorize("isAuthenticated()")`, which `src/middleware.ts`
 *   already enforces for this path (it is not in `PUBLIC_PATHS`), so the
 *   handler adds no role check of its own. The *visibility* rule — the owning
 *   designer sees every bid, anyone else sees only their own — is not an
 *   endpoint property but a per-mission one, so it lives in
 *   `BidService.listForMission`, the layer that loads the mission.
 *
 * Everything else these handlers could be tempted to do is likewise the
 * service's: a hidden mission (or one whose designer is suspended) surfaces as
 * `MissionNotFoundError` -> 404 rather than a 403 that would confirm the id
 * exists, a closed mission / passed deadline / already-decided bid as
 * `BidConflictError` -> 409, and a suspended pilot as `UserSuspendedError`.
 * `withErrorHandling()` maps all of them; the handlers stay parse -> validate
 * -> service -> shape.
 *
 * `POST /api/v1/bids/{id}/accept` — the designer's award flow — is the fourth
 * endpoint of this controller and lives in `bids/[id]/accept/route.ts`.
 *
 * SOURCE: drone-missions-backend/.../web/controller/bid/BidController.java
 * (`place`, `listForMission`)
 */

/** The dynamic segment this route file owns. */
type BidMissionRouteContext = { params: Promise<{ missionId: string }> };

/**
 * The path variable, validated the way `@PathVariable Long missionId` is:
 * Spring converts it and answers 400 (`MethodArgumentTypeMismatchException`)
 * when the segment is not a number. Parsing it through Zod puts that same
 * rejection on `withErrorHandling()`'s validation branch — the mechanism this
 * port uses for every bad parameter — and keeps the wording identical to
 * `missions/[id]/route.ts`, whose schema this mirrors including its
 * safe-integer bound (the JS counterpart of `Long`'s range: an id past
 * `2^53 - 1` cannot round-trip through a JS number, and the row it would name
 * cannot exist, since the column is an identity `bigint` starting at 1).
 */
const missionIdSchema = z.object({
  missionId: z
    .string()
    .regex(/^-?\d+$/, "must be a number")
    .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
    .transform(Number),
});

/**
 * Parses `{missionId}` out of the matched route segment. Wrapped in an object
 * schema so the rejection reaches the client keyed as `missionId` — the
 * closest equivalent of the source's
 * `Invalid value for parameter 'missionId'`.
 */
async function missionId(context: BidMissionRouteContext): Promise<number> {
  return missionIdSchema.parse(await context.params).missionId;
}

/**
 * Places the calling pilot's bid on a mission, or updates their pending one
 * (one bid per pilot per mission). Mirrors `BidController.place`.
 *
 * Answers **200**, not 201: the source returns `ResponseEntity.ok(...)` here
 * — which is the honest status, since the same call updates an existing bid
 * just as often as it creates one, and no `Location` header is produced.
 *
 * The role check runs *after* the body is validated, matching the source's
 * ordering rather than reversing it: Spring MVC resolves and validates the
 * `@Valid @RequestBody` argument while binding the handler method's arguments,
 * before the method-security advice around the controller bean evaluates
 * `@PreAuthorize` — so a designer posting a zero amount gets the same 400
 * there that they get here, not a 403. Nothing observable happens before the
 * check: parsing is pure, and every write is behind it. (The same reasoning is
 * spelled out on `POST /api/v1/missions`.)
 */
export const POST = withErrorHandling<BidMissionRouteContext>(async (request, context) => {
  const id = await missionId(context);
  const caller = getCurrentUser(request);
  const body = await request.json();
  const { amount, message } = bidRequestSchema.parse(body);
  requireRole(caller, "PILOT");

  const bid = await place(id, caller.id, amount, message);
  return NextResponse.json<BidResponse>(toBidResponse(bid));
});

/**
 * The bids on a mission that the caller is allowed to see — every one of them
 * for the owning designer, only their own for anyone else. Mirrors
 * `BidController.listForMission`.
 *
 * Any authenticated role may call this, including a designer who does not own
 * the mission (they simply get an empty list, or their own bid if they somehow
 * placed one). The caller id comes off the headers `middleware.ts` attaches
 * from the verified token's `sub` claim — the analogue of
 * `@AuthenticationPrincipal Long userId` — so the split can never be pointed
 * at another user by way of the query string.
 */
export const GET = withErrorHandling<BidMissionRouteContext>(async (request, context) => {
  const id = await missionId(context);
  const caller = getCurrentUser(request);

  const bids = await listForMission(id, caller.id);
  return NextResponse.json<BidResponse[]>(bids.map(toBidResponse));
});
