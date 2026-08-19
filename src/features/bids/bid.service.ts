import "server-only";
import { bidPlaced, bidWithdrawn, record } from "@/lib/audit";
import { emailService } from "@/lib/email/email.service";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { getMissionDao } from "@/features/missions/mission.cache";
import { MissionNotFoundError } from "@/features/missions/mission.service";
import type { Mission, MissionStatus } from "@/features/missions/mission.types";
import { findById as findUserById } from "@/features/users/user.queries";
import { UserSuspendedError } from "@/features/users/user.service";
import * as queries from "./bid.queries";
import type { Bid } from "./bid.types";

/**
 * Bid business logic (replaces `business.service.bid.BidService`).
 *
 * Phase-3 slice: `place`, `listForMission`, `myBids`, `withdraw`. The fifth
 * method, `accept` — one bid becomes ACCEPTED, the mission is AWARDED to its
 * pilot, every other pending bid is REJECTED, and both sides get an in-app
 * notification plus a decision email — is **Phase 5** and is deliberately not
 * implemented here. That is also why this module has no `NotificationService`
 * collaborator: `place` sends no in-app notification (see below), so `accept`
 * is the only method that needs one.
 *
 * Two source details this port keeps exactly, because both are load-bearing:
 *
 *  - `place` loads the mission through `findFresh`, never the cached
 *    `findById`. It is about to write the mission back as BIDDING, and a
 *    cached snapshot would be saved over live columns (`awardedPilotId`, a
 *    concurrent status change). `listForMission` is read-only and therefore
 *    uses the cached lookup — the same split `MissionService` documents.
 *  - a hidden mission, or one whose designer is suspended, raises
 *    `MissionNotFoundError` rather than a 403: a mission the caller may not
 *    bid on must be indistinguishable from one that does not exist, or the
 *    status code itself would confirm the id. `withdraw` applies the same rule
 *    to someone else's bid.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/bid/BidService.java
 * - drone-missions-backend/.../business/exception/bid/{BidNotFoundException,BidConflictException}.java
 * - test drone-missions-backend/.../business/service/bid/BidServiceTest.java
 */

/**
 * Thrown when a bid cannot be found by id — including when it exists but
 * belongs to another pilot, which is masked as not-found so bid ids cannot be
 * probed (the source's stated reason). Mirrors `BidNotFoundException`; the
 * base (`NotFoundError`) maps to 404.
 */
export class BidNotFoundError extends NotFoundError {
  constructor(id: number) {
    super(`Bid ${id} not found`);
  }
}

/**
 * Thrown when a bid action conflicts with the current state: bidding on a
 * closed mission or one past its deadline, or changing/withdrawing a bid that
 * has already been decided. Mirrors `BidConflictException`; the base
 * (`ConflictError`) maps to 409.
 *
 * The message is passed in rather than built from an id, exactly as in the
 * source — the four call sites word the conflict differently and the Angular
 * client surfaces the text verbatim in its error toast.
 */
export class BidConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Bids can only be placed/updated while the mission is open for offers.
 * Mirrors `BidService.BIDDABLE_STATUSES`.
 *
 * Note this is not the same set as `MissionService.OPEN_STATUSES` even though
 * both currently read `PUBLISHED, BIDDING`: one answers "is this on the public
 * marketplace", the other "may an offer still be made". The source keeps them
 * as two independent constants and so does this port.
 */
const BIDDABLE_STATUSES: readonly MissionStatus[] = Object.freeze(["PUBLISHED", "BIDDING"]);

/**
 * Place the caller's bid on a mission, or update it if a pending one already
 * exists (one bid per pilot per mission — `bid_mission_pilot_unique`). The
 * first bid on a PUBLISHED mission flips it to BIDDING so the lifecycle
 * reflects real activity. Mirrors `BidService.place`.
 *
 * The order of the checks is the source's, and it is observable: moderation
 * before the pilot lookup (so a suspended pilot probing a hidden mission still
 * gets a 404, not a 403), the pilot's suspension before the status/deadline
 * rules (so a suspended pilot never learns whether bidding was even open).
 *
 * @throws MissionNotFoundError if the mission does not exist, is hidden, or its
 * designer is suspended
 * @throws UserNotFoundError if no such pilot exists (raised by the user query)
 * @throws UserSuspendedError if the pilot's account is suspended
 * @throws BidConflictError if the mission is not open for bidding, its deadline
 * has passed, or the pilot's existing bid has already been decided
 */
export async function place(
  missionId: number,
  pilotId: number,
  amount: number,
  message: string | null | undefined,
): Promise<Bid> {
  // Fresh, not cached: the first bid on a PUBLISHED mission writes it back as BIDDING.
  const mission = await getFreshMissionOrThrow(missionId);
  // A moderated mission, or one whose designer is suspended, must be
  // indistinguishable from a missing one — probing ids reveals nothing.
  if (
    mission.moderation !== "VISIBLE" ||
    (mission.designer !== null && mission.designer.suspended)
  ) {
    throw new MissionNotFoundError(missionId);
  }
  // `findById` here is the *user* query, which throws `UserNotFoundError`
  // itself — the port of `.orElseThrow(() -> new UserNotFoundException(id))`.
  const pilot = await findUserById(pilotId);
  if (pilot.suspended) {
    throw new UserSuspendedError();
  }
  if (!BIDDABLE_STATUSES.includes(mission.status)) {
    throw new BidConflictError(`Mission ${missionId} is not open for bidding`);
  }
  // The deadline day itself is still open; bidding closes once it has passed.
  if (mission.biddingDeadline !== null && today() > mission.biddingDeadline) {
    throw new BidConflictError(`The bidding deadline for mission ${missionId} has passed`);
  }

  const existing = await queries.findByMissionAndPilot(missionId, pilotId);
  if (existing !== undefined && existing.status !== "PENDING") {
    throw new BidConflictError(`Bid ${existing.id} has already been decided and cannot be changed`);
  }
  const updated = existing !== undefined;
  // The source mutates the loaded entity (or a freshly constructed one) and
  // hands it to `save()`; the equivalent here is a write object carrying the
  // existing row's id when there is one — that id is what makes `save()` take
  // its UPDATE branch, and its absence what makes a new bid INSERT as PENDING.
  const saved = await queries.save({
    id: existing?.id,
    missionId,
    pilotId,
    amount,
    message: message ?? null,
    // Always PENDING in practice (a decided bid was rejected above), written
    // as the source writes it: a fresh bid is constructed PENDING, an existing
    // one keeps the status it already had.
    status: existing?.status ?? "PENDING",
  });

  if (mission.status === "PUBLISHED") {
    await getMissionDao().save({ ...mission, status: "BIDDING" });
  }

  // Let the mission's owner know a bid came in (best-effort email — the port
  // never rejects, mirroring the source's `@Async void` send). The source
  // sends NO in-app notification on place; only the accept flow (Phase 5)
  // creates notifications, so none is created here.
  const designer = mission.designer;
  const pilotName = pilot.username;
  if (designer !== null) {
    await emailService.sendNewBid({
      designer: { email: designer.email, username: designer.username },
      // `mission.name` is nullable in this schema while the mail port takes a
      // plain `string`; an unnamed mission renders as an empty subject/body
      // slot here, where Thymeleaf would have printed nothing for a null too.
      mission: { id: mission.id, name: mission.name ?? "", location: mission.location },
      pilotName,
      amount,
      message,
    });
  }
  await record(bidPlaced(pilotId, saved, updated));
  return saved;
}

/**
 * The bids visible to the caller on a mission: the owning designer sees them
 * all, newest first; anyone else sees only their own (so the same endpoint
 * feeds both the designer's list and the pilot's "your bid" panel). Mirrors
 * `BidService.listForMission`.
 *
 * Read-only, so the cached mission lookup is used — the result is never saved.
 * Note the mission only has to *exist*: the source deliberately does not apply
 * `MissionService.isVisibleTo` here, so a pilot keeps seeing their own bid on
 * a mission that has since been hidden.
 *
 * @throws MissionNotFoundError if no such mission exists
 */
export async function listForMission(missionId: number, currentUserId: number): Promise<Bid[]> {
  const mission = await getMissionOrThrow(missionId);
  if (currentUserId === mission.userId) {
    return queries.findByMissionOrderByCreatedAtDesc(missionId);
  }
  const own = await queries.findByMissionAndPilot(missionId, currentUserId);
  return own === undefined ? [] : [own];
}

/** Every bid the caller has placed, newest first. Mirrors `BidService.myBids`. */
export async function myBids(pilotId: number): Promise<Bid[]> {
  return queries.findByPilotOrderByCreatedAtDesc(pilotId);
}

/**
 * Withdraw (delete) the caller's pending bid. Mirrors `BidService.withdraw`.
 *
 * A bid that is not the caller's own is reported as not found rather than
 * forbidden, so bid ids can't be probed (mirrors the mission visibility
 * pattern). The audit entry is built from the bid loaded *before* the delete —
 * the row is gone afterwards, so that entry is all that survives of it.
 *
 * @throws BidNotFoundError if no such bid exists, or it belongs to another pilot
 * @throws BidConflictError if the bid has already been decided
 */
export async function withdraw(bidId: number, pilotId: number): Promise<void> {
  const bid = await getBidOrThrow(bidId);
  if (pilotId !== bid.pilot.id) {
    throw new BidNotFoundError(bidId);
  }
  if (bid.status !== "PENDING") {
    throw new BidConflictError(`Bid ${bidId} has already been decided and cannot be withdrawn`);
  }
  await queries.deleteBid(bid);
  await record(bidWithdrawn(pilotId, bid));
}

/** Read-only lookup — may be served from cache, so never hand the result to `save()`. */
async function getMissionOrThrow(missionId: number): Promise<Mission> {
  const mission = await getMissionDao().findById(missionId);
  if (mission === undefined) {
    throw new MissionNotFoundError(missionId);
  }
  return mission;
}

/** Lookup for a flow that is about to modify the mission — always a live database row. */
async function getFreshMissionOrThrow(missionId: number): Promise<Mission> {
  const mission = await getMissionDao().findFresh(missionId);
  if (mission === undefined) {
    throw new MissionNotFoundError(missionId);
  }
  return mission;
}

async function getBidOrThrow(bidId: number): Promise<Bid> {
  const bid = await queries.findById(bidId);
  if (bid === undefined) {
    throw new BidNotFoundError(bidId);
  }
  return bid;
}

/**
 * Today as a `yyyy-MM-dd` calendar day in the server's local zone — the port
 * of `LocalDate.now()`.
 *
 * Compared against `mission.biddingDeadline` with `>`, which is a plain string
 * comparison: both sides are zero-padded ISO-8601 dates, for which
 * lexicographic and chronological order coincide, so this is exactly
 * `LocalDate.isAfter`. Keeping the deadline as a string (rather than parsing
 * it into a `Date`) is the same decision `mission.mapper.ts` documents: a
 * `LocalDate` has no time or zone, and giving it one can shift the day across
 * a boundary — which here would close bidding a day early or late.
 *
 * The local zone matters and is the source's too (`LocalDate.now()` uses the
 * system zone): deadlines are entered and displayed as calendar days in the
 * app's timezone. Set `TZ` on the deployment to pin which one, exactly as
 * `mission.service.ts`'s day-bounds filter already requires.
 */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
