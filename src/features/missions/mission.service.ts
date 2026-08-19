import "server-only";
import { getDb } from "@/db/client";
import {
  missionCancelled,
  missionCompleted,
  missionCreated,
  missionDeleted,
  missionStarted,
  missionUpdated,
  record,
} from "@/lib/audit";
import { emailService } from "@/lib/email/email.service";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import * as bidQueries from "@/features/bids/bid.queries";
import { create as createNotification } from "@/features/notifications/notification.service";
import { NewNotification } from "@/features/notifications/notification.types";
import {
  findById as findUserById,
  findByIdOrUndefined as findUserByIdOrUndefined,
} from "@/features/users/user.queries";
import { UserSuspendedError } from "@/features/users/user.service";
import { getMissionDao } from "./mission.cache";
import type { Mission, MissionStatus, MissionWrite } from "./mission.types";

/**
 * Mission business logic (replaces `business.service.mission.MissionService`).
 *
 * Phase-2 slice: `create`, `findOpen`, `findOwnedBy`, `findById`, `update`,
 * `delete`; Phase 5 adds the lifecycle transitions (`start`, `complete`,
 * `cancel`) and `findAwardedTo`. Moderation (`hide`/`unhide`/`remove`) and the
 * admin listing (`searchAll`) are Phase 7 — each lands with the routes that
 * call it.
 *
 * ## The lifecycle never advances on its own
 * A mission moves AWARDED -> IN_PROGRESS -> COMPLETED only because the awarded
 * pilot said so, and to CANCELLED only because the owning designer said so.
 * There is deliberately **no** lazy transition on read: nothing here (or
 * anywhere else in this port) promotes an AWARDED mission to IN_PROGRESS
 * because its `startTime` has passed. That mirrors the source exactly —
 * `MissionService.start`'s javadoc states "a mission never advances on its
 * own", and `IN_PROGRESS` is assigned in that one method and nowhere else in
 * `src/main/java`. The migration plan and the Angular repo's notes claim such
 * an on-read promotion exists; it does not, and the source wins.
 *
 * Every read and write goes through `getMissionDao()` rather than
 * `mission.queries.ts` directly, so the caching decorator observes all of
 * them (see `mission.cache.ts`) — the same indirection `MissionService` gets
 * from being injected with the `MissionDao` interface instead of
 * `JpaMissionDao`.
 *
 * The `findById` / `findFresh` split is load-bearing here, not stylistic: a
 * read-only lookup may be served a cached copy, while every flow that will
 * write must load a live row first, or it would save a stale snapshot back
 * over columns (`status`, `awardedPilotId`) the edit deliberately never
 * touches.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/mission/MissionService.java
 * - drone-missions-backend/.../business/exception/mission/{MissionNotFoundException,MissionAccessDeniedException}.java
 * - drone-missions-backend/.../business/exception/user/UserSuspendedException.java
 * - test drone-missions-backend/.../business/service/mission/MissionServiceTest.java
 */

/**
 * Thrown when a mission cannot be found by id — or when the caller may not
 * see it (see `findById`). Mirrors `MissionNotFoundException`; the base
 * (`NotFoundError`) maps to 404.
 */
export class MissionNotFoundError extends NotFoundError {
  constructor(id: number) {
    super(`Mission ${id} not found`);
  }
}

/**
 * Thrown when a user tries to modify or delete a mission they do not own.
 * Mirrors `MissionAccessDeniedException`; the base (`ForbiddenError`) maps
 * to 403.
 */
export class MissionAccessDeniedError extends ForbiddenError {
  constructor(missionId: number) {
    super(`You are not allowed to modify mission ${missionId}`);
  }
}

/**
 * Thrown when a mission action conflicts with its current lifecycle status —
 * starting one that was never awarded, completing one that has not started,
 * cancelling one that is already finished. Mirrors
 * `MissionConflictException`; the base (`ConflictError`) maps to 409.
 *
 * The message is passed in rather than built from an id, exactly as in the
 * source: each call site words the conflict differently (and names the status
 * it refused), and the Angular client surfaces the text verbatim in its error
 * toast.
 */
export class MissionConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * The statuses that make a mission part of the open marketplace — work
 * actually on offer, visible to everyone. DRAFT is excluded because the
 * designer is still planning it. AWARDED and later belong to one chosen
 * pilot, and no mission records who that is yet, so they stay hidden from
 * everyone rather than shown to all.
 *
 * Mirrors `MissionService.OPEN_STATUSES`. Frozen because it is shared with
 * every `OpenMissionQuery` this module builds, and those are cache keys.
 */
const OPEN_STATUSES: readonly MissionStatus[] = Object.freeze(["PUBLISHED", "BIDDING"]);

/**
 * The mission fields a create or update request supplies — precisely the
 * fields `MissionMapper.toEntity` sets on the entity the controller hands to
 * this service, and nothing else. Ownership (`userId`), moderation and
 * `awardedPilotId` are never client-supplied.
 *
 * `update` ignores `status`, exactly as the source does: it receives the same
 * fully-populated entity from the mapper and simply never copies that field
 * across.
 */
export type MissionDraft = Pick<
  MissionWrite,
  | "name"
  | "description"
  | "status"
  | "startTime"
  | "endTime"
  | "location"
  | "biddingDeadline"
  | "waypoints"
  | "geofence"
>;

/**
 * Creates a mission owned by the given designer. Mirrors
 * `MissionService.create`: ownership is set here, not in the route handler,
 * which has no business holding a query module.
 *
 * @throws UserNotFoundError if no such designer exists (raised by the user query)
 * @throws UserSuspendedError if the designer's account is suspended
 */
export async function create(draft: MissionDraft, designerId: number): Promise<Mission> {
  const designer = await findUserById(designerId);
  if (designer.suspended) {
    throw new UserSuspendedError();
  }
  const saved = await getMissionDao().save({
    ...draft,
    userId: designer.id,
    // A brand-new mission has no awarded pilot, and its moderation state is
    // left to `save()`'s VISIBLE default — mirroring the field initializer on
    // a freshly constructed Java entity.
    awardedPilotId: null,
  });
  await record(missionCreated(designerId, saved));
  return saved;
}

/**
 * The open marketplace: every mission currently available for work, visible
 * to all, narrowed by the optional feed filters. Mirrors
 * `MissionService.findOpen`.
 *
 * Blank location/keyword and an absent date are treated as "not filtering".
 * The date selects missions flyable on that day — i.e. whose flight window
 * overlaps it — and is a calendar day (`yyyy-MM-dd`), which the route
 * validates before calling; day bounds are resolved in the server's local
 * zone so the filter matches the dates as they were entered and are
 * displayed (the client stores/shows flight windows in local time). A fixed
 * UTC boundary would be off by the timezone offset. Assumes the app runs in
 * a single timezone — set `TZ` on the deployment to pin which one.
 */
export async function findOpen(
  location: string | null | undefined,
  keyword: string | null | undefined,
  date: string | null | undefined,
): Promise<Mission[]> {
  const { from, to } = dayBounds(date);
  return getMissionDao().findOpen({
    statuses: OPEN_STATUSES,
    location: normalize(location),
    keyword: normalize(keyword),
    from,
    to,
  });
}

/**
 * Treats a null/blank filter value as "not provided" so the query layer skips
 * the predicate entirely, and lowercases the rest. Mirrors
 * `MissionService.normalize`.
 *
 * Both filters match case-insensitively at the SQL layer, so without this two
 * requests differing only in case (e.g. "Novi Sad" vs. "novi sad") would build
 * unequal queries and land as separate entries in the list cache despite
 * returning identical results.
 */
function normalize(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }
  return value.trim().toLowerCase();
}

/**
 * Resolves a calendar day into the half-open instant range
 * `[dayStart, dayEndExclusive)` in the server's local zone. Mirrors
 * `date.atStartOfDay(zone).toInstant()` / `date.plusDays(1)...`.
 *
 * The parts are passed to the `Date` constructor separately on purpose:
 * `new Date("2026-08-18")` is parsed as *UTC* midnight by spec, which is the
 * very timezone shift this function exists to avoid. Day-of-month overflow
 * (`d + 1` past the end of a month) is normalised by the constructor, exactly
 * as `plusDays(1)` is.
 */
function dayBounds(date: string | null | undefined): { from: Date | null; to: Date | null } {
  if (date === null || date === undefined) {
    return { from: null, to: null };
  }
  const [year, month, day] = date.split("-").map(Number);
  return {
    from: new Date(year, month - 1, day),
    to: new Date(year, month - 1, day + 1),
  };
}

/** The missions the caller created and owns. Mirrors `findOwnedBy`. */
export async function findOwnedBy(currentUserId: number): Promise<Mission[]> {
  return getMissionDao().findByUserId(currentUserId);
}

/**
 * The missions awarded to the calling pilot — their "jobs". Mirrors
 * `MissionService.findAwardedTo`.
 *
 * A plain pass-through with no visibility filter, exactly as in the source:
 * the awarded pilot is one of the two people `isVisibleTo` lets past
 * unconditionally, so a job stays on this list even after the mission leaves
 * the open statuses or is hidden from the marketplace. Reading it changes
 * nothing about a mission's status — see this module's header.
 */
export async function findAwardedTo(pilotId: number): Promise<Mission[]> {
  return getMissionDao().findByAwardedPilotId(pilotId);
}

/**
 * Looks up one mission the caller is allowed to see. Mirrors
 * `MissionService.findById`.
 *
 * @throws MissionNotFoundError if no such mission exists *or* the caller may
 * not see it — a mission a caller cannot read must not be distinguishable
 * from one that does not exist, or the 404 vs. 403 itself would confirm a
 * draft's existence. This is why the visibility failure is deliberately not
 * a `MissionAccessDeniedError`.
 */
export async function findById(id: number, currentUserId: number): Promise<Mission> {
  const mission = await getOrThrow(id);
  if (!isVisibleTo(mission, currentUserId)) {
    throw new MissionNotFoundError(id);
  }
  return mission;
}

/**
 * Applies an owner's edit. Mirrors `MissionService.update`: load a live row,
 * check ownership, copy across only the fields an edit may change, save.
 *
 * The mission's lifecycle `status` and its `moderation`, ownership and
 * awarded pilot all survive untouched — they come from the freshly loaded
 * row, never from the request. The source achieves this by simply not
 * calling `setStatus` on the loaded entity; spreading the loaded mission and
 * overriding the editable fields is the same thing said in one expression.
 *
 * @throws MissionNotFoundError if no such mission exists
 * @throws MissionAccessDeniedError if the caller does not own it
 */
export async function update(
  id: number,
  changes: MissionDraft,
  currentUserId: number,
): Promise<Mission> {
  const mission = await getFreshOrThrow(id);
  requireOwner(mission, currentUserId);

  const saved = await getMissionDao().save({
    ...mission,
    name: changes.name,
    description: changes.description,
    startTime: changes.startTime,
    endTime: changes.endTime,
    location: changes.location,
    biddingDeadline: changes.biddingDeadline,
    waypoints: changes.waypoints,
    geofence: changes.geofence,
  });
  await record(missionUpdated(currentUserId, saved));
  return saved;
}

/**
 * Deletes an owner's mission. Mirrors `MissionService.delete`; bids,
 * notifications and ratings go with it through the `ON DELETE CASCADE`
 * foreign keys, and only the audit row keeps the history — which is why the
 * entry is built from the mission loaded *before* the delete.
 *
 * @throws MissionNotFoundError if no such mission exists
 * @throws MissionAccessDeniedError if the caller does not own it
 */
export async function deleteMission(id: number, currentUserId: number): Promise<void> {
  const mission = await getFreshOrThrow(id);
  requireOwner(mission, currentUserId);
  await getMissionDao().delete(mission);
  await record(missionDeleted(currentUserId, mission));
}

/**
 * The awarded pilot starts the mission, moving it AWARDED -> IN_PROGRESS.
 * Mirrors `MissionService.start`.
 *
 * Only the awarded pilot may start it, and only while it is still AWARDED.
 * Starting is a deliberate action — a mission never advances on its own, which
 * is why there is no on-read promotion anywhere in this module (see the header).
 *
 * Neither a notification nor an email is raised: the source sends none here,
 * and none on `complete` either. The designer learns of the change from the
 * mission itself; only cancellation, whose loser is a pilot who was counting
 * on the work, is announced.
 *
 * @throws MissionNotFoundError if no such mission exists
 * @throws MissionAccessDeniedError if the caller is not the awarded pilot
 * @throws UserSuspendedError if the awarded pilot's account is suspended
 * @throws MissionConflictError if the mission is not AWARDED
 */
export async function start(id: number, pilotId: number): Promise<Mission> {
  const mission = await getFreshOrThrow(id);
  requireAwardedPilot(mission, pilotId);
  await requireUnsuspended(pilotId);
  if (mission.status !== "AWARDED") {
    throw new MissionConflictError(`Mission ${id} cannot be started from status ${mission.status}`);
  }
  const saved = await getMissionDao().save({ ...mission, status: "IN_PROGRESS" });
  await record(missionStarted(pilotId, saved));
  return saved;
}

/**
 * The winning pilot marks the mission finished, moving it to COMPLETED.
 * Mirrors `MissionService.complete`.
 *
 * The same two guards as `start`, differing only in the status it demands: the
 * mission must actually be underway (IN_PROGRESS), so it has to be started
 * first and cannot be completed twice. No notification, no email — as in
 * `start`.
 *
 * @throws MissionNotFoundError if no such mission exists
 * @throws MissionAccessDeniedError if the caller is not the awarded pilot
 * @throws UserSuspendedError if the awarded pilot's account is suspended
 * @throws MissionConflictError if the mission is not IN_PROGRESS
 */
export async function complete(id: number, pilotId: number): Promise<Mission> {
  const mission = await getFreshOrThrow(id);
  requireAwardedPilot(mission, pilotId);
  await requireUnsuspended(pilotId);
  if (mission.status !== "IN_PROGRESS") {
    throw new MissionConflictError(
      `Mission ${id} cannot be completed from status ${mission.status}`,
    );
  }
  const saved = await getMissionDao().save({ ...mission, status: "COMPLETED" });
  await record(missionCompleted(pilotId, saved));
  return saved;
}

/**
 * The mission's creator cancels it, moving it to CANCELLED. Mirrors
 * `MissionService.cancel`.
 *
 * Allowed from any status that is not yet COMPLETED (and not already
 * CANCELLED) — including AWARDED and IN_PROGRESS, which is exactly why the
 * awarded pilot has to be told. Every outstanding bid is rejected so no pilot
 * is left expecting to win: **PENDING *and* ACCEPTED**, the latter being the
 * winner's own bid on a mission that was already awarded.
 *
 * ## Atomicity
 * The cancellation and the bid rejections run in one `db.transaction` — the
 * port of the source's `@Transactional`. A mission left CANCELLED while its
 * accepted bid still reads ACCEPTED would tell the winning pilot they had
 * won work that no longer exists, and that state is reachable if the second
 * write fails. The cached mission copy is evicted twice, once by the write
 * itself and once after the commit returns, which is what
 * `CachingMissionDao`'s `afterCompletion` synchronisation does in Java (see
 * `mission.cache.ts`); `bid.service.ts`'s `accept` follows the same pattern.
 *
 * KNOWN DIVERGENCE — the notification and the audit entry are raised *after*
 * the transaction commits, where the source raises them inside it (its
 * `NotificationService`/`AuditService` are not themselves transactional, so
 * they join the caller's transaction). Observable only if one of those inserts
 * fails: Spring would roll the cancellation back, this port keeps it and lets
 * the error surface. Deliberate, and identical to the choice `accept`
 * documents — the cancellation is the user's intent, its announcement a side
 * effect, and un-cancelling a mission because a notification row would not
 * insert is the worse failure. The email was always outside the transaction
 * (`@Async` in the source, best-effort here).
 *
 * @throws MissionNotFoundError if no such mission exists
 * @throws MissionAccessDeniedError if the caller does not own it
 * @throws MissionConflictError if it is already COMPLETED or CANCELLED
 */
export async function cancel(id: number, designerId: number): Promise<Mission> {
  const mission = await getFreshOrThrow(id);
  requireOwner(mission, designerId);
  if (mission.status === "COMPLETED" || mission.status === "CANCELLED") {
    throw new MissionConflictError(
      `Mission ${id} cannot be cancelled from status ${mission.status}`,
    );
  }

  const cancelled = await getDb().transaction(async (tx) => {
    const saved = await getMissionDao().save({ ...mission, status: "CANCELLED" }, tx);
    // Read every bid and filter in memory rather than querying the two
    // statuses: the source's own shape, and it keeps the "outstanding" rule
    // (PENDING *or* ACCEPTED) readable in one place next to the write.
    const bids = await bidQueries.findByMissionOrderByCreatedAtDesc(mission.id, tx);
    for (const bid of bids) {
      if (bid.status === "PENDING" || bid.status === "ACCEPTED") {
        // Sequential, not `Promise.all`: a transaction is one connection, and
        // interleaving statements on it is not something the driver supports.
        await bidQueries.save({ ...bid, status: "REJECTED" }, tx);
      }
    }
    return saved;
  });
  // The commit has landed; drop anything a concurrent reader cached from the
  // pre-cancellation row while the transaction was open.
  getMissionDao().invalidate(mission.id);

  // Only the awarded pilot is told, and only if there is one: everyone else
  // holding a bid was still guessing, and the source notifies none of them
  // (their bids are simply rejected).
  const pilotId = mission.awardedPilotId;
  if (pilotId !== null) {
    // `mission.name` is nullable in this schema while both the notification
    // copy and the mail port take a plain `string`; an unnamed mission renders
    // as an empty slot inside the quotes, which is what Thymeleaf printed for
    // a null too — the same substitution `bid.service.ts` already makes.
    const target = { id: mission.id, name: mission.name ?? "" };
    await createNotification(NewNotification.missionCancelled(pilotId, target));
    // The non-throwing lookup, mirroring the source's `.ifPresent`: a
    // cancellation that has already been written must not be undone by an
    // absent mailbox.
    const pilot = await findUserByIdOrUndefined(pilotId);
    if (pilot !== undefined) {
      await emailService.sendMissionCancelled(
        { email: pilot.email, username: pilot.username },
        { ...target, location: mission.location },
      );
    }
  }
  // One row per *intent*: the rejected bids are not audited, exactly as
  // `AuditAction`'s javadoc spells out (see `missionCancelled` in `audit.ts`).
  await record(missionCancelled(designerId, cancelled));
  return cancelled;
}

/** Read-only lookup — may be served from cache, so never hand the result to `save()`. */
async function getOrThrow(id: number): Promise<Mission> {
  const mission = await getMissionDao().findById(id);
  if (mission === undefined) {
    throw new MissionNotFoundError(id);
  }
  return mission;
}

/** Lookup for a flow that is about to modify the mission — always a live database row. */
async function getFreshOrThrow(id: number): Promise<Mission> {
  const mission = await getMissionDao().findFresh(id);
  if (mission === undefined) {
    throw new MissionNotFoundError(id);
  }
  return mission;
}

/**
 * Visible to its owner, to the awarded pilot, or to anyone once it is open
 * for work. Mirrors `MissionService.isVisibleTo`; the feed's extra
 * requirement — an unsuspended designer — applies to the direct lookup too,
 * so a suspended designer's mission disappears from both at once.
 */
function isVisibleTo(mission: Mission, currentUserId: number): boolean {
  if (currentUserId === mission.userId || currentUserId === mission.awardedPilotId) {
    return true;
  }
  return (
    OPEN_STATUSES.includes(mission.status) &&
    mission.moderation === "VISIBLE" &&
    (mission.designer === null || !mission.designer.suspended)
  );
}

/** Only the mission's creator may modify or delete it. Mirrors `requireOwner`. */
function requireOwner(mission: Mission, currentUserId: number): void {
  if (currentUserId !== mission.userId) {
    throw new MissionAccessDeniedError(mission.id);
  }
}

/**
 * Only the pilot the mission was awarded to may drive its lifecycle. Mirrors
 * the `!pilotId.equals(mission.getAwardedPilotId())` check that opens both
 * `start` and `complete`.
 *
 * A mission with no awarded pilot fails this for everyone, which is the same
 * outcome the source reaches (`equals` against a null id is false) — and it is
 * why the suspension check below can safely dereference the pilot afterwards.
 */
function requireAwardedPilot(mission: Mission, pilotId: number): void {
  if (pilotId !== mission.awardedPilotId) {
    throw new MissionAccessDeniedError(mission.id);
  }
}

/**
 * The suspension guard `start` and `complete` share. The source reads the flag
 * off the mission's loaded `@ManyToOne awardedPilot` relation; this port keeps
 * only `awardedPilotId` on `Mission` (see `mission.types.ts`), so the account
 * is fetched.
 *
 * The throwing lookup is safe and no ordering is observable: this runs only
 * once `requireAwardedPilot` has established that the id is the caller's own,
 * and that caller is an authenticated user whose row exists.
 *
 * @throws UserSuspendedError if the account is suspended
 */
async function requireUnsuspended(pilotId: number): Promise<void> {
  const pilot = await findUserById(pilotId);
  if (pilot.suspended) {
    throw new UserSuspendedError();
  }
}
