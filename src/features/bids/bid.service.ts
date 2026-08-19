import "server-only";
import { getDb } from "@/db/client";
import { bidAccepted, bidPlaced, bidWithdrawn, record } from "@/lib/audit";
import { emailService } from "@/lib/email/email.service";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { getMissionDao } from "@/features/missions/mission.cache";
import {
  MissionAccessDeniedError,
  MissionNotFoundError,
} from "@/features/missions/mission.service";
import type { Mission, MissionStatus } from "@/features/missions/mission.types";
import { create as createNotification } from "@/features/notifications/notification.service";
import { NewNotification } from "@/features/notifications/notification.types";
import {
  findById as findUserById,
  findByIdOrUndefined as findUserByIdOrUndefined,
} from "@/features/users/user.queries";
import { UserSuspendedError } from "@/features/users/user.service";
import * as queries from "./bid.queries";
import type { Bid } from "./bid.types";

/**
 * Bid business logic (replaces `business.service.bid.BidService`).
 *
 * All five methods: `place`, `listForMission`, `myBids`, `withdraw` and
 * `accept`. `accept` is the only one that notifies — `place` sends an email
 * but raises no in-app notification (see below) — and the only one that
 * writes more than one row, hence the only `db.transaction` here.
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
  // sends NO in-app notification on place; only `accept` below creates
  // notifications, so none is created here.
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

/**
 * Accept one bid: it becomes ACCEPTED, every *other* pending bid on the
 * mission is REJECTED, and the mission is AWARDED to the bid's pilot. Only the
 * mission's owner may award, and only while it is still open. Mirrors
 * `BidService.accept`.
 *
 * ## Guard order (the source's, and observable)
 * bid exists -> **fresh** mission -> caller owns the mission -> mission still
 * open -> bid still pending -> pilot not suspended. Two of those orderings
 * carry meaning:
 *
 *  - the mission is loaded through `findFresh`, never the cached `findById`:
 *    this flow writes the mission back as AWARDED, and merging a cached
 *    snapshot would revert whatever a concurrent bid changed (the same rule
 *    `place` follows).
 *  - the ownership check comes *before* both conflict checks, so a stranger
 *    poking at bid ids always gets 403 and never learns from a 409 whether
 *    the mission was already awarded.
 *
 * A suspended pilot's bid is **frozen, not rejected**: the last guard leaves
 * it PENDING, so it becomes acceptable again if the account is reactivated —
 * the source's explicit comment, and the reason this is a conflict rather
 * than a silent skip.
 *
 * ## Atomicity
 * The three writes (winner ACCEPTED, losers REJECTED, mission AWARDED) run in
 * one `db.transaction`, the port of the source's `@Transactional`: a mission
 * awarded with its losing bids left pending — or a winner accepted on a
 * mission that never got awarded — would be unrecoverable state, and both are
 * reachable if the second write fails. The cached mission copy is evicted
 * twice, once by the write itself and once after the commit returns, which is
 * what `CachingMissionDao`'s `afterCompletion` synchronisation does in Java
 * (see `mission.cache.ts`).
 *
 * KNOWN DIVERGENCE — notifications and the audit entry are raised *after* the
 * transaction commits, where the source raises them inside it (its
 * `NotificationService`/`AuditService` are not themselves transactional, so
 * they join the caller's transaction). Observable only if a notification or
 * audit insert fails: Spring would roll the acceptance back, this port keeps
 * it and lets the error surface. Deliberate, and the direction the plan
 * specifies — the acceptance is the user's intent, while its notification is
 * a side effect, and re-opening an already-awarded mission because a
 * notification row would not insert is the worse failure. The emails were
 * always outside the transaction: `@Async` in the source, best-effort here.
 *
 * @throws BidNotFoundError if no such bid exists
 * @throws MissionNotFoundError if the bid's mission has since been deleted
 * @throws MissionAccessDeniedError if the caller does not own the mission
 * @throws BidConflictError if the mission has already been awarded, the bid
 * has already been decided, or its pilot is suspended
 */
export async function accept(bidId: number, designerId: number): Promise<Bid> {
  const bid = await getBidOrThrow(bidId);
  // Fresh, not cached: this awards the mission and writes it back.
  const mission = await getFreshMissionOrThrow(bid.mission.id);
  if (designerId !== mission.userId) {
    throw new MissionAccessDeniedError(mission.id);
  }
  if (!BIDDABLE_STATUSES.includes(mission.status)) {
    throw new BidConflictError(`Mission ${mission.id} has already been awarded`);
  }
  if (bid.status !== "PENDING") {
    throw new BidConflictError(`Bid ${bidId} has already been decided`);
  }
  // The suspension flag lives on the pilot's account. The source reads it off
  // the loaded `@ManyToOne` relation; the joined pilot here carries only the
  // two columns the mapper needs (never a password hash), so the account is
  // fetched — and then reused as the awarded pilot below. The throwing lookup
  // is safe: `bid.pilot_id` is NOT NULL with a foreign key (V8), so the row
  // cannot be missing, and this runs only after every earlier guard has
  // passed, so no ordering is observable.
  const pilot = await findUserById(bid.pilot.id);
  if (pilot.suspended) {
    // Frozen, not rejected: the bid stays pending and becomes acceptable again
    // if the pilot is reactivated.
    throw new BidConflictError(`Bid ${bidId} cannot be accepted while its pilot is suspended`);
  }

  const { winner, losers } = await getDb().transaction(async (tx) => {
    const accepted = await queries.save({ ...bid, status: "ACCEPTED" }, tx);
    // Re-read inside the transaction rather than trusting the caller's view:
    // this is the set of bids that are still pending *now*. The winner is
    // already ACCEPTED by this point and so cannot come back, but the
    // source's explicit id filter is kept — it is what makes the intent
    // ("every *other* pending bid") independent of the write order.
    const stillPending = await queries.findByMissionAndStatus(mission.id, "PENDING", tx);
    const rejected: Bid[] = [];
    for (const other of stillPending) {
      if (other.id === bid.id) {
        continue;
      }
      // Sequential, not `Promise.all`: a transaction is one connection, and
      // interleaving statements on it is not something the driver supports.
      rejected.push(await queries.save({ ...other, status: "REJECTED" }, tx));
    }

    await getMissionDao().save({ ...mission, status: "AWARDED", awardedPilotId: pilot.id }, tx);
    return { winner: accepted, losers: rejected };
  });
  // The commit has landed; drop anything a concurrent reader cached from the
  // pre-award row while the transaction was open.
  getMissionDao().invalidate(mission.id);

  await notifyDecision(mission, winner, true);
  for (const loser of losers) {
    await notifyDecision(mission, loser, false);
  }
  await record(bidAccepted(designerId, winner));
  return winner;
}

/**
 * In-app notification + best-effort email to a pilot whose bid was decided.
 * Mirrors `BidService.notifyDecision`, including its re-lookup of the pilot:
 * the account is fetched with the non-throwing query and a missing one simply
 * gets no email (`.ifPresent`), because a decision that has already been
 * written must not be undone by an absent mailbox.
 *
 * `mission.name` is nullable in this schema while both the notification copy
 * and the mail port take a plain `string`; an unnamed mission therefore
 * renders as an empty slot inside the quotes, which is what Thymeleaf printed
 * for a null too — the same substitution `place`'s email already makes.
 */
async function notifyDecision(mission: Mission, bid: Bid, accepted: boolean): Promise<void> {
  const target = { id: mission.id, name: mission.name ?? "" };
  await createNotification(
    accepted
      ? NewNotification.bidAccepted(bid.pilot.id, target)
      : NewNotification.bidRejected(bid.pilot.id, target),
  );
  const pilot = await findUserByIdOrUndefined(bid.pilot.id);
  if (pilot !== undefined) {
    await emailService.sendBidDecision(
      { email: pilot.email, username: pilot.username },
      { ...target, location: mission.location },
      bid.amount,
      accepted,
    );
  }
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
