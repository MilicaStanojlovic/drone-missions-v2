import { apiFetch } from "@/features/auth/auth.client";
import { ensureOk } from "@/lib/api/client";
import type { BidResponse } from "@/features/bids/bid.types";

/**
 * Client-side bid access: the browser-facing mirror of the bids feature.
 * Replaces `services/bid.service.ts` (the HTTP calls) — its display constants
 * (`BID_STATUS_LABELS` / `BID_STATUS_COLORS`) already live in `bid.types.ts`,
 * which, unlike the rest of the feature, is deliberately isomorphic, so there
 * is no second copy of them here.
 *
 * Why a separate module rather than calling the service directly: every other
 * runtime module under `features/bids/` (`bid.service.ts`, `bid.queries.ts`,
 * `bid.mapper.ts`, `bid.schema.ts`) starts with `import "server-only"` and
 * throws the moment its code is pulled into a client bundle. The *types* are
 * still safe to reuse, because `import type` is erased at compile time and
 * emits no runtime import — the same technique `mission.client.ts` uses for
 * `MissionResponse`. So the shapes below are derived from the server DTO
 * rather than hand-copied, and there is no second source of truth to drift.
 *
 * There is no HttpClient/interceptor layer in this stack: every call goes
 * through `apiFetch`, which attaches the Bearer token and handles session
 * expiry exactly as `authInterceptor` did, and `ensureOk` turns a 4xx/5xx
 * into the `ApiError` that carries the server's `{ data, status, message }`
 * envelope (`fetch` resolves for those, where HttpClient throws).
 *
 * SOURCE: drone-missions-frontend/.../services/bid.service.ts
 */

/**
 * One bid as the API returns it — `BidResponse` with its `createdAt` /
 * `updatedAt` as ISO-8601 strings, which is what `NextResponse.json` writes
 * and `response.json()` reads back. Mirrors how the Angular `Bid` model types
 * the backend's `Instant` fields as `string`.
 */
export type Bid = Omit<BidResponse, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

/**
 * The body `POST /api/v1/bids/mission/{missionId}` accepts — the wire form of
 * `bidRequestSchema`'s input, which is `BidRequest` field for field. Ports the
 * Angular `BidPayload`: the server assigns the id, the pilot, the status and
 * the timestamps, so none of them are client-supplied.
 */
export interface BidPayload {
  amount: number;
  message?: string;
}

const BASE_URL = "/api/v1/bids";

/**
 * Places the caller's bid on a mission, or updates their pending one (one bid
 * per pilot per mission). Mirrors `place`.
 *
 * Answers 200 rather than 201 — see the route handler: the same call updates
 * an existing bid as often as it creates one.
 */
export async function placeBid(missionId: number, payload: BidPayload): Promise<Bid> {
  const response = await ensureOk(
    await apiFetch(`${BASE_URL}/mission/${missionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return (await response.json()) as Bid;
}

/**
 * The bids on a mission the caller may see: the owning designer gets every
 * one of them, newest first; anyone else gets only their own (0 or 1 items).
 * That split is the server's, not this helper's. Mirrors `listForMission`.
 */
export async function fetchBidsForMission(missionId: number): Promise<Bid[]> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/mission/${missionId}`));
  return (await response.json()) as Bid[];
}

/** Every bid the calling pilot has placed, newest first. Mirrors `myBids`. */
export async function fetchMyBids(): Promise<Bid[]> {
  const response = await ensureOk(await apiFetch(`${BASE_URL}/my`));
  return (await response.json()) as Bid[];
}

/**
 * The owning designer awards their mission to this bid. Mirrors `accept`.
 *
 * Answers the accepted `Bid` alone, exactly as the source's
 * `post<Bid>(.../accept, {})` does — the cascade behind it (every other bid
 * rejected, the mission AWARDED, both sides notified) is not in the response,
 * which is why every caller re-reads mission *and* bids afterwards rather than
 * patching the returned bid into its list.
 *
 * The empty `{}` body Angular sends is dropped: `HttpClient.post` requires a
 * body argument where `fetch` does not, and the route takes its whole input
 * from the path, so there is nothing to send.
 */
export async function acceptBid(bidId: number): Promise<Bid> {
  const response = await ensureOk(
    await apiFetch(`${BASE_URL}/${bidId}/accept`, { method: "POST" }),
  );
  return (await response.json()) as Bid;
}

/** Withdraws (deletes) the caller's pending bid — 204, no body. Mirrors `withdraw`. */
export async function withdrawBid(bidId: number): Promise<void> {
  await ensureOk(await apiFetch(`${BASE_URL}/${bidId}`, { method: "DELETE" }));
}
