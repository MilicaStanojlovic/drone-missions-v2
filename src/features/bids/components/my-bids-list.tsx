"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Toast, useToast } from "@/components/toast";
import { fetchMyBids, withdrawBid, type Bid } from "../bid.client";
import { BID_STATUS_COLORS, BID_STATUS_LABELS } from "../bid.types";

/**
 * The pilot's bid history: every bid they have placed, newest first, each row
 * linking to its mission and offering Withdraw while the bid is still pending.
 *
 * Ports `MyBidsComponent` — template, styles and behaviour: the three body
 * states (loading / error / empty-with-CTA), the row layout (mission link,
 * optional quoted note, placed-on date | status chip, amount, Withdraw), and
 * the withdraw flow, including its details:
 * - `withdrawing` holds the id of the row in flight, so only that row's button
 *   shows "Withdrawing…" and is disabled, and a second click anywhere is
 *   ignored while one is running (`if (this.withdrawing !== null) return`);
 * - success re-loads the whole list rather than splicing the row out
 *   (`this.load()`), so a bid the server decided in the meantime is not shown
 *   as still pending;
 * - the toasts are the source's fixed strings — note that, unlike the mission
 *   detail's withdraw, this one does NOT surface the server's message on
 *   failure, it always says "Could not withdraw the bid".
 *
 * The rows link with `?from=my-bids`, which is what makes the mission detail
 * show "Back to my bids" instead of "Back to missions".
 *
 * SOURCE: drone-missions-frontend/.../components/my-bids/my-bids.component.{ts,html,css}
 */

/**
 * Angular's `| date: 'mediumDate'` ("Jun 15, 2015"). A local copy of the
 * helper `mission-list.tsx` keeps for the same pipe: both are private to their
 * component, and neither feature should have to import the other's client
 * bundle for a date format.
 */
function mediumDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function MyBidsList() {
  const [bids, setBids] = useState<Bid[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  /** Id of the bid currently being withdrawn, or null. Ports `withdrawing`. */
  const [withdrawing, setWithdrawing] = useState<number | null>(null);
  const { toast, show } = useToast();

  /** Ports `load()`. */
  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    fetchMyBids()
      .then((loaded) => {
        setBids(loaded);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        console.error("Failed to load bids", cause);
        setError(true);
        setLoading(false);
      });
  }, []);

  // `ngOnInit`.
  useEffect(() => load(), [load]);

  /** Ports `withdraw(bid)`. */
  function withdraw(bid: Bid): void {
    if (withdrawing !== null) {
      return;
    }
    setWithdrawing(bid.id);
    withdrawBid(bid.id)
      .then(() => {
        setWithdrawing(null);
        show(`Bid on “${bid.missionName}” withdrawn`);
        load();
      })
      .catch((cause: unknown) => {
        console.error("Failed to withdraw bid", cause);
        setWithdrawing(null);
        show("Could not withdraw the bid", "#e04a3f");
      });
  }

  return (
    <section className="mx-auto max-w-[860px] px-[22px] pt-[34px] pb-[60px]">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-role-pilot mb-1.5 font-mono text-[10.5px] tracking-[0.14em]">
            PILOT
          </div>
          <h1 className="m-0 text-[28px] font-bold text-[#16222e]">My Bids</h1>
        </div>
      </header>

      {loading ? (
        <p className="py-10 text-center text-[#6b7c8d]">Loading your bids…</p>
      ) : error ? (
        <p className="py-10 text-center text-[#c43a30]">
          {"Couldn't load your bids. Please try again."}
        </p>
      ) : bids.length === 0 ? (
        <div className="rounded-[14px] border-[1.5px] border-dashed border-[#d3dbe3] px-5 py-14 text-center">
          <div className="text-lg font-semibold text-[#37475a]">No bids yet</div>
          <div className="mt-1.5 text-sm text-[#8494a5]">
            Find a mission on the feed and place your first bid.
          </div>
          <Link
            href="/missions"
            className="bg-role-pilot mt-4 inline-block rounded-[9px] px-[18px] py-2.5 text-[13.5px] font-semibold text-white no-underline"
          >
            Browse missions
          </Link>
        </div>
      ) : (
        <div className="bg-card border-border overflow-hidden rounded-[14px] border shadow-[0_1px_2px_rgba(20,35,55,0.05)]">
          {bids.map((bid) => (
            <div
              key={bid.id}
              className="flex items-center justify-between gap-[18px] border-b border-[#f2f5f8] px-5 py-4 last:border-b-0 max-[560px]:flex-col max-[560px]:items-start"
            >
              <div>
                <Link
                  href={`/missions/${bid.missionId}?from=my-bids`}
                  className="hover:text-role-pilot text-[15px] font-semibold text-[#16222e] no-underline"
                >
                  {bid.missionName}
                </Link>
                {bid.message && (
                  <div className="mt-1 text-[13px] text-[#4a5a6a] italic">“{bid.message}”</div>
                )}
                <div className="mt-1 text-xs text-[#93a1b0]">
                  Placed {mediumDate(bid.createdAt)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3.5 max-[560px]:w-full max-[560px]:justify-between">
                <span
                  className="inline-flex items-center gap-1.5 rounded-[20px] border px-2.5 py-1 font-mono text-[10.5px] tracking-[0.06em] uppercase"
                  style={{
                    color: BID_STATUS_COLORS[bid.status],
                    background: `${BID_STATUS_COLORS[bid.status]}1a`,
                    borderColor: `${BID_STATUS_COLORS[bid.status]}55`,
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: BID_STATUS_COLORS[bid.status] }}
                  />
                  {BID_STATUS_LABELS[bid.status]}
                </span>
                <div className="text-foreground min-w-[70px] text-right font-mono text-[18px] font-semibold">
                  ${bid.amount}
                </div>
                {bid.status === "PENDING" && (
                  <button
                    type="button"
                    className="bg-card cursor-pointer rounded-lg border border-[#f0c9c5] px-3.5 py-2 text-[13px] font-semibold text-[#c43a30] transition-colors hover:enabled:border-[#e04a3f] hover:enabled:bg-[#e04a3f] hover:enabled:text-white disabled:cursor-default disabled:opacity-60"
                    disabled={withdrawing === bid.id}
                    onClick={() => withdraw(bid)}
                  >
                    {withdrawing === bid.id ? "Withdrawing…" : "Withdraw"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Toast toast={toast} />
    </section>
  );
}
