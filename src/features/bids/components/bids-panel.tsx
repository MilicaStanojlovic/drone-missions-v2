"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { serverMessage } from "@/lib/api/client";
import { Toast, useToast } from "@/components/toast";
import type { MissionStatus } from "@/features/missions/mission.types";
import { placeBid, withdrawBid, type Bid } from "../bid.client";

/**
 * The mission detail page's bids aside — one panel with two faces, exactly as
 * the source template branches on `auth.isPilot`:
 *
 * - **Pilot — "Your bid":** their current bid (amount, note, won/lost marker,
 *   Withdraw while it is still pending) above the place/update form, or one of
 *   the two closed-for-bidding messages.
 * - **Anyone else — "Bids":** every bid on the mission, newest first, with the
 *   pilot's name, amount, note and status tag, plus the "N bids" count.
 *
 * Ports the `<aside class="panel">` half of `mission-detail.component.html`,
 * its `.panel*` / `.mybid*` / `.bid*` / `.bidfield*` styles, and the "pilot
 * bidding" section of the component class (`myBid`, `deadlinePassed`,
 * `canBid`, `placeBid`, `withdrawBid`, `bidCountText`). It is a component of
 * its own rather than more markup inside `MissionDetail` because it owns
 * genuinely local state — the two form fields and the in-flight flag — that
 * nothing else on the page reads; the *list* stays with the parent, which
 * needs `bids.length` for the telemetry tile and re-loads both mission and
 * bids after every action (`onChanged`, the source's `refresh()`).
 *
 * Deliberately NOT ported, because their APIs land later and a stubbed control
 * that 404s is worse parity than an absent one:
 * - the designer's **Accept** button and its confirm dialog, and with them
 *   `hasAward` / `firstName` / `askAccept` / `confirmAccept` — the award flow
 *   is Phase 5 (`POST /api/v1/bids/{id}/accept` does not exist yet). The
 *   ACCEPTED / REJECTED *renderings* below are ported: those statuses are set
 *   by the backend, so a bid can already arrive in one.
 * - the `isWinner` "finish" block (Start mission / Mark finished) that the
 *   source renders above the pilot's bid — `MissionService.start/complete`,
 *   Phase 5.
 *
 * SOURCE: drone-missions-frontend/.../components/mission-detail/mission-detail.component.{ts,html,css}
 */

/**
 * What this panel needs of the mission it is bidding on. A structural shape
 * rather than the whole `Mission`, so the bids feature does not depend on the
 * missions client module; any `Mission` is assignable to it.
 */
export interface BidsPanelMission {
  id: number;
  status: MissionStatus;
  /** A `yyyy-MM-dd` calendar date, or null when the designer set none. */
  biddingDeadline?: string | null;
}

export interface BidsPanelProps {
  mission: BidsPanelMission;
  /**
   * The bids the API returned for this mission: every one of them for the
   * owning designer, only the caller's own (0 or 1) for a pilot.
   */
  bids: Bid[];
  isPilot: boolean;
  /** Re-load mission + bids in place after a successful action (`refresh()`). */
  onChanged: () => void;
}

const PANEL_EMPTY = "px-5 py-[34px] text-center text-[13.5px] text-[#93a1b0]";
const FIELD_LABEL =
  "mb-[7px] block font-mono text-[10.5px] tracking-[0.08em] text-[#6b7c8d] uppercase";
const FIELD_INPUT =
  "w-full rounded-lg border border-[#dbe2ea] bg-[#f7f9fb] px-3 py-[11px] text-sm outline-none focus:border-[#12a06a] focus:bg-white";
const MYBID_LABEL = "font-mono text-[9.5px] tracking-[0.08em] text-[#a2afbc] uppercase";
const BID_TAG =
  "rounded-[20px] border border-[#dbe2ea] px-[7px] py-0.5 font-mono text-[9.5px] tracking-[0.08em] text-[#93a1b0]";

/** "1 bid" / "3 bids". Ports `bidCountText`. */
function bidCountText(count: number): string {
  return count === 1 ? "1 bid" : `${count} bids`;
}

/**
 * Whether the bidding deadline — inclusive of its whole day, hence the
 * `T23:59:59` — has gone by. Ports `deadlinePassed`. A mission with no
 * deadline never closes on time alone, only on status.
 */
function deadlinePassed(mission: BidsPanelMission): boolean {
  const deadline = mission.biddingDeadline;
  return !!deadline && new Date() > new Date(deadline + "T23:59:59");
}

export function BidsPanel({ mission, bids, isPilot, onChanged }: BidsPanelProps) {
  const [bidAmount, setBidAmount] = useState("");
  const [bidMessage, setBidMessage] = useState("");
  const [bidBusy, setBidBusy] = useState(false);
  const { toast, show } = useToast();

  /** The caller's own bid — for pilots the API returns only theirs (0/1 items). Ports `myBid`. */
  const myBid = isPilot ? bids[0] : undefined;
  const closed = deadlinePassed(mission);
  /** Ports `canBid`. */
  const canBid = isPilot && ["PUBLISHED", "BIDDING"].includes(mission.status) && !closed;

  function place(): void {
    if (bidBusy) {
      return;
    }
    const existing = myBid;
    // Updating an existing bid: a blank amount field means "keep the current price",
    // so you can change just the message without re-typing the amount.
    const typed = bidAmount.trim();
    const amount = typed ? Math.round(Number(typed)) : (existing?.amount ?? 0);
    // Catches 0, a negative, and — since `Number("abc")` is NaN, which is
    // falsy — anything unparseable, exactly as the source's `!amount` does.
    if (!amount || amount <= 0) {
      show("Enter a valid bid amount", "#e04a3f");
      return;
    }
    const updating = !!existing;
    // Same "blank = keep" rule for the message: an empty box on an update keeps the
    // existing message instead of clearing it, so changing only the amount leaves it intact.
    const typedMessage = bidMessage.trim();
    const message = typedMessage || (updating ? existing?.message : undefined);
    setBidBusy(true);
    placeBid(mission.id, { amount, message: message || undefined })
      .then(() => {
        setBidBusy(false);
        setBidAmount("");
        setBidMessage("");
        show(`${updating ? "Bid updated" : "Bid placed"} — $${amount}`, "#12a06a");
        onChanged();
      })
      .catch((error: unknown) => {
        console.error("Failed to place bid", error);
        setBidBusy(false);
        show(serverMessage(error, "Could not place the bid"), "#e04a3f");
      });
  }

  function withdraw(): void {
    const bid = myBid;
    if (!bid || bidBusy) {
      return;
    }
    setBidBusy(true);
    withdrawBid(bid.id)
      .then(() => {
        setBidBusy(false);
        show("Bid withdrawn");
        onChanged();
      })
      .catch((error: unknown) => {
        console.error("Failed to withdraw bid", error);
        setBidBusy(false);
        show(serverMessage(error, "Could not withdraw the bid"), "#e04a3f");
      });
  }

  return (
    <>
      <aside className="bg-card overflow-hidden rounded-xl border border-[#e8edf2] shadow-[0_1px_2px_rgba(20,35,55,0.04),0_8px_24px_rgba(20,35,55,0.05)]">
        {isPilot ? (
          <>
            <div className="flex items-center justify-between border-b border-[#eef2f6] px-[18px] py-4">
              <span className="text-foreground text-[15px] font-semibold">Your bid</span>
            </div>
            <div className="px-[18px] py-4">
              {myBid && (
                <div className="mb-3.5 rounded-[10px] border border-[#e8edf2] bg-[#f7f9fb] px-[15px] py-3.5">
                  <div className={MYBID_LABEL}>Current bid</div>
                  <div className="text-foreground mt-1 font-mono text-2xl font-semibold">
                    ${myBid.amount}
                  </div>
                  {myBid.message && (
                    <div className="mt-1.5 text-[13px] text-[#4a5a6a] italic">
                      “{myBid.message}”
                    </div>
                  )}
                  {myBid.status === "ACCEPTED" && (
                    <div className="mt-2 text-[13px] font-semibold text-[#12a06a]">
                      ✓ You won this mission
                    </div>
                  )}
                  {myBid.status === "REJECTED" && (
                    <div className="mt-2 text-[13px] font-semibold text-[#93a1b0]">
                      This bid was not accepted
                    </div>
                  )}
                  {myBid.status === "PENDING" && (
                    <button
                      type="button"
                      className="bg-card mt-[11px] w-full cursor-pointer rounded-lg border border-[#f0c9c5] p-2 text-[13px] font-semibold text-[#c43a30] transition-colors hover:enabled:border-[#e04a3f] hover:enabled:bg-[#e04a3f] hover:enabled:text-white disabled:cursor-default disabled:opacity-60"
                      disabled={bidBusy}
                      onClick={withdraw}
                    >
                      Withdraw bid
                    </button>
                  )}
                </div>
              )}

              {canBid ? (
                <>
                  <label className="mb-3 block">
                    <span className={FIELD_LABEL}>
                      {myBid ? "Update your bid (USD)" : "Your bid (USD)"}
                    </span>
                    <input
                      className={FIELD_INPUT}
                      type="number"
                      min="1"
                      placeholder={
                        myBid ? `Current: $${myBid.amount} (leave blank to keep)` : "e.g. 450"
                      }
                      value={bidAmount}
                      onChange={(event) => setBidAmount(event.target.value)}
                    />
                  </label>
                  <label className="mb-3 block">
                    <span className={FIELD_LABEL}>Message (optional)</span>
                    <textarea
                      className={cn(FIELD_INPUT, "min-h-[52px] resize-y")}
                      rows={2}
                      maxLength={500}
                      placeholder={
                        myBid?.message
                          ? "Leave blank to keep your current message"
                          : "Anything the designer should know…"
                      }
                      value={bidMessage}
                      onChange={(event) => setBidMessage(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="w-full cursor-pointer rounded-[9px] bg-[#12a06a] p-3 text-sm font-semibold text-white shadow-[0_3px_12px_rgba(18,160,106,0.26)] transition-colors hover:enabled:bg-[#0f8c5c] disabled:cursor-default disabled:opacity-60"
                    disabled={bidBusy}
                    onClick={place}
                  >
                    {myBid ? "Update bid" : "Place bid"}
                  </button>
                </>
              ) : closed ? (
                <div className={PANEL_EMPTY}>Bidding is closed — the deadline has passed.</div>
              ) : (
                !myBid && <div className={PANEL_EMPTY}>This mission isn&apos;t open for bids.</div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-[#eef2f6] px-[18px] py-4">
              <span className="text-foreground text-[15px] font-semibold">Bids</span>
              <span className="font-mono text-xs text-[#93a1b0]">{bidCountText(bids.length)}</span>
            </div>
            {bids.length === 0 ? (
              <div className={PANEL_EMPTY}>No bids have come in yet.</div>
            ) : (
              <div>
                {bids.map((bid) => (
                  <div
                    key={bid.id}
                    className={cn(
                      "border-b border-[#f2f5f8] px-[18px] py-3.5",
                      bid.status === "ACCEPTED" && "bg-[#faf9ff]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="text-foreground text-sm font-semibold">
                          {bid.pilotName}
                        </span>
                        {bid.status === "ACCEPTED" && (
                          <span
                            className={cn(BID_TAG, "border-[#cfc4ff] bg-[#f3f1ff] text-[#7c5cff]")}
                          >
                            ACCEPTED
                          </span>
                        )}
                        {bid.status === "REJECTED" && <span className={BID_TAG}>REJECTED</span>}
                      </div>
                      <div className="text-foreground shrink-0 font-mono text-[19px] font-semibold">
                        ${bid.amount}
                      </div>
                    </div>
                    {bid.message && (
                      <div className="mt-[7px] text-[13px] text-[#4a5a6a] italic">
                        “{bid.message}”
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </aside>

      <Toast toast={toast} />
    </>
  );
}
