import "server-only";
import type { Bid, BidResponse } from "@/features/bids/bid.types";

/**
 * Bid DTO mapping (replaces `web.mapper.bid.BidMapper`).
 *
 * The Java mapper's own javadoc is the whole design note: "No repositories:
 * the mission and pilot names come off the relations, so the per-bid lookups
 * this used to do are gone." The same holds here — a `Bid` arrives from
 * `bid.queries.ts` with `mission` and `pilot` already resolved by the join, so
 * this module is a pure, synchronous field copy with no data access of its own
 * (unlike `mission.mapper.ts`, whose designer-rating summary genuinely has to
 * be fetched).
 *
 * Only `toResponse` is ported: `BidMapper` has no other method.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/mapper/bid/BidMapper.java
 * - drone-missions-backend/.../web/dto/bid/BidResponse.java
 */

/**
 * Shapes one bid into its public response. Mirrors `BidMapper.toResponse`
 * field for field, in the record's declaration order.
 *
 * Every field is listed explicitly rather than spread off the row, matching
 * `toMissionResponse`/`toUserResponse`: the bid row carries nothing secret
 * today, but a whitelist cannot start leaking a column a later migration adds
 * — and the two relation objects (`mission`, `pilot`) must not reach the wire
 * at all, since the DTO flattens them into `missionName`/`pilotName`.
 *
 * `amount` is already a number by the time it gets here (`bid.queries.ts`
 * narrows the `numeric` column's decimal text once, at the query boundary), so
 * no conversion happens in the mapper — same as the Java side handing the
 * entity's `BigDecimal` straight to the record.
 */
export function toBidResponse(bid: Bid): BidResponse {
  return {
    id: bid.id,
    // The mission/pilot ids are read off the resolved relations, exactly as
    // the source reads `bid.getMission().getId()` / `bid.getPilot().getId()`
    // rather than the FK columns — identical values, but it keeps the mapper
    // honest about what the join is for.
    missionId: bid.mission.id,
    missionName: bid.mission.name,
    pilotId: bid.pilot.id,
    pilotName: bid.pilot.username,
    amount: bid.amount,
    message: bid.message,
    status: bid.status,
    createdAt: bid.createdAt,
    updatedAt: bid.updatedAt,
  };
}
