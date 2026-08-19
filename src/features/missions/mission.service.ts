import "server-only";
import { missionCreated, missionDeleted, missionUpdated, record } from "@/lib/audit";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { findById as findUserById } from "@/features/users/user.queries";
import { UserSuspendedError } from "@/features/users/user.service";
import { getMissionDao } from "./mission.cache";
import type { Mission, MissionStatus, MissionWrite } from "./mission.types";

/**
 * Mission business logic (replaces `business.service.mission.MissionService`).
 *
 * Phase-2 slice: `create`, `findOpen`, `findOwnedBy`, `findById`, `update`,
 * `delete`. The lifecycle transitions (`start`/`complete`/`cancel` and
 * `findAwardedTo`) are Phase 5, moderation (`hide`/`unhide`/`remove`) and the
 * admin listing (`searchAll`) are Phase 7 — each lands with the routes that
 * call it.
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
