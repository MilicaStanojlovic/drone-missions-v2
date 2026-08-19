import "server-only";
import { and, desc, eq, gte, inArray, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mission, users, type MissionStatus } from "@/db/schema";
import type { User } from "@/features/users/user.types";
import type { Geofence, Mission, MissionRow, MissionWrite, Waypoint } from "./mission.types";

/**
 * The mission data-access layer (replaces `data.access.JpaMissionDao` + the
 * `data.repository.MissionRepository` methods it is the only permitted
 * consumer of).
 *
 * This module holds no cache: `findById` and `findFresh` run the same query
 * here, and the two only diverge once the caching decorator wraps this module
 * — the same split the source draws between `JpaMissionDao` and
 * `CachingMissionDao`. The distinction is load-bearing regardless: a
 * read-only flow may take a cached copy from `findById`, while anything that
 * will call `save()` must load through `findFresh` so it never writes a stale
 * snapshot back over columns (`status`, `awardedPilotId`) an edit deliberately
 * never touches.
 *
 * Phase-2 slice only. `findByAwardedPilotId` (Phase 5), `findOverdue`
 * (Phase 8), `searchAll` and `countByStatus` (Phases 7/9) and the decorator's
 * `invalidateLists` (Phase 3's cache task) are not ported here.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/access/JpaMissionDao.java
 * - drone-missions-backend/.../data/access/MissionDao.java (contract + findById/findFresh rule)
 * - drone-missions-backend/.../data/access/OpenMissionQuery.java
 * - drone-missions-backend/.../data/repository/MissionRepository.java (`findByDesigner_Id`)
 * - drone-missions-backend/.../data/model/Mission.java
 */

/**
 * The normalised filters for one open-marketplace search. Mirrors the
 * `OpenMissionQuery` record: blank text filters and an absent date arrive
 * here as `null`, already trimmed and lowercased, and the day-boundary
 * instants have already been resolved in the caller's timezone. This type
 * carries values, not policy — the business layer decides which statuses
 * count as "open" and does the normalising (that normalisation is what keeps
 * two case-different searches for the same thing from becoming two distinct
 * entries in the list cache).
 */
export interface OpenMissionQuery {
  /** The statuses considered "open" — supplied by the caller. */
  statuses: readonly MissionStatus[];
  /** Substring match on location, lowercased and trimmed, or null. */
  location: string | null;
  /** Substring match on name or description, lowercased and trimmed, or null. */
  keyword: string | null;
  /** Inclusive lower bound the flight window must reach, or null. */
  from: Date | null;
  /** Exclusive upper bound the flight window must start before, or null. */
  to: Date | null;
}

/** The row shape every read below produces before narrowing. */
type JoinedRow = { mission: MissionRow; users: User | null };

/**
 * Narrows a joined row into a `Mission`.
 *
 * The two `jsonb` columns are `unknown` at the Drizzle level (the migrations
 * declare them as bare `jsonb`, and `src/db/schema.ts` mirrors the migrations
 * rather than adding narrowing a `drizzle-kit pull` would drop). Postgres
 * hands back whatever JSON was written, so this cast is the same unchecked
 * trust Hibernate's `@JdbcTypeCode(SqlTypes.JSON)` places in the column on
 * the Java side — request-time validation (`mission.schema.ts`) is what
 * guarantees the shape going in.
 */
function toMission(row: JoinedRow): Mission {
  return {
    ...row.mission,
    waypoints: row.mission.waypoints as Waypoint[] | null,
    geofence: row.mission.geofence as Geofence | null,
    designer: row.users,
  };
}

/**
 * The base read: every mission column plus its designer account.
 *
 * A LEFT join, never an inner one — `mission.user_id` is nullable for legacy
 * rows created before authentication existed, and an inner join would
 * silently drop those ownerless missions from every list (the source's
 * `MissionControllerTest` asserts they survive the open feed).
 */
function selectMissions() {
  return getDb().select().from(mission).leftJoin(users, eq(mission.userId, users.id));
}

/**
 * Look up a mission for a read-only flow. Mirrors `JpaMissionDao.findById`
 * (`Optional.empty()` becomes `undefined`).
 *
 * Never hand the result to `save()` — use `findFresh` for that; once the
 * caching decorator is in place this may return a cached copy.
 */
export async function findById(id: number): Promise<Mission | undefined> {
  const [row] = await selectMissions().where(eq(mission.id, id));
  return row ? toMission(row) : undefined;
}

/**
 * Look up a mission that is about to be modified. Mirrors
 * `JpaMissionDao.findFresh`: the same query as `findById` here, because this
 * module holds no cache. It stays a separate entry point so the caching
 * decorator has a seam to make it always hit the database (and evict any
 * cached copy on the way through) without any call site changing.
 */
export async function findFresh(id: number): Promise<Mission | undefined> {
  const [row] = await selectMissions().where(eq(mission.id, id));
  return row ? toMission(row) : undefined;
}

/**
 * The open marketplace, filtered, newest-created first. Mirrors
 * `JpaMissionDao.findOpen`'s `Specification`: the `where` is assembled
 * dynamically so only the filters actually supplied become predicates — no
 * null bind parameters reach SQL.
 */
export async function findOpen(query: OpenMissionQuery): Promise<Mission[]> {
  // `and()` drops `undefined` members, so an unsupplied filter contributes
  // nothing to the SQL at all — the direct analogue of not adding a Predicate.
  const conditions: (SQL | undefined)[] = [
    inArray(mission.status, [...query.statuses]),
    // Moderation: only VISIBLE missions from unsuspended designers reach the
    // feed. Constant predicates, so OpenMissionQuery cache keys stay valid;
    // legacy ownerless rows (null designer) stay visible.
    eq(mission.moderation, "VISIBLE"),
    or(isNull(mission.userId), eq(users.suspended, false)),
  ];

  // `lower(col) LIKE %value%` rather than `ILIKE`: a literal port of the
  // source's `cb.like(cb.lower(...), ...)`, which lowercases the pattern in
  // Java too even though the caller already normalised it. LIKE metacharacters
  // in the filter value are not escaped, matching the source exactly — a `%`
  // typed into the feed filter widens the match there as well.
  if (query.location !== null) {
    conditions.push(like(sql`lower(${mission.location})`, `%${query.location.toLowerCase()}%`));
  }

  if (query.keyword !== null) {
    const pattern = `%${query.keyword.toLowerCase()}%`;
    conditions.push(
      or(
        like(sql`lower(${mission.description})`, pattern),
        like(sql`lower(${mission.name})`, pattern),
      ),
    );
  }

  // Flight-window overlap with [from, to). Guarded on `from` alone, exactly
  // as the source is: the service resolves both day bounds together, so `to`
  // is non-null whenever `from` is.
  if (query.from !== null && query.to !== null) {
    conditions.push(and(lt(mission.startTime, query.to), gte(mission.endTime, query.from)));
  }

  const rows = await selectMissions()
    .where(and(...conditions))
    .orderBy(desc(mission.createdAt));
  return rows.map(toMission);
}

/**
 * Missions created by this user. Mirrors `MissionRepository.findByDesigner_Id`
 * — no moderation filter, because HIDDEN only affects the open feed and an
 * owner always sees their own missions.
 */
export async function findByUserId(userId: number): Promise<Mission[]> {
  const rows = await selectMissions().where(eq(mission.userId, userId));
  return rows.map(toMission);
}

/**
 * Persist a new or modified mission and return it with its designer resolved.
 * Mirrors `JpaMissionDao.save` over Spring Data's `save()`: an absent id
 * inserts, a present id merges *every* column of the supplied object over the
 * row — which is precisely why a mutating flow must load through `findFresh`
 * rather than `findById`.
 *
 * The timestamps are stamped here because neither column has a database
 * default (see `V1__create_mission_table.sql`); Hibernate's
 * `@CreationTimestamp`/`@UpdateTimestamp` do it on the Java side, and
 * `created_at` is `updatable = false`, so an update never rewrites it.
 *
 * The saved row is re-read through the designer join instead of being
 * assembled from the write: `returning()` yields the mission columns only,
 * and callers (the mapper above all) need the designer account attached.
 */
export async function save(input: MissionWrite): Promise<Mission> {
  const now = new Date();
  const columns = {
    name: input.name,
    description: input.description,
    status: input.status,
    moderation: input.moderation ?? "VISIBLE",
    userId: input.userId,
    awardedPilotId: input.awardedPilotId,
    startTime: input.startTime,
    endTime: input.endTime,
    location: input.location,
    biddingDeadline: input.biddingDeadline,
    waypoints: input.waypoints,
    geofence: input.geofence,
  };

  let savedId: number;
  if (input.id === undefined || input.id === null) {
    const [inserted] = await getDb()
      .insert(mission)
      .values({ ...columns, createdAt: now, updatedAt: now })
      .returning({ id: mission.id });
    savedId = inserted.id;
  } else {
    const [updated] = await getDb()
      .update(mission)
      .set({ ...columns, updatedAt: now })
      .where(eq(mission.id, input.id))
      .returning({ id: mission.id });
    if (!updated) {
      // The row vanished between the caller's `findFresh` and this write.
      // Hibernate fails the same way (merging a detached entity whose row is
      // gone), and no caller can recover, so this stays an unmapped error
      // rather than one of the HTTP-mapped `AppError` subclasses.
      throw new Error(`Mission ${input.id} no longer exists`);
    }
    savedId = updated.id;
  }

  const saved = await findFresh(savedId);
  if (!saved) {
    throw new Error(`Mission ${savedId} vanished immediately after being saved`);
  }
  return saved;
}

/**
 * Delete a mission. Mirrors `JpaMissionDao.delete`, which takes the loaded
 * entity and uses only its id; bids, notifications and ratings go with it
 * through the `ON DELETE CASCADE` foreign keys the migrations declare.
 *
 * Named `deleteMission` rather than `delete` only because `delete` is a
 * reserved word and cannot name a function declaration.
 */
export async function deleteMission(target: Pick<Mission, "id">): Promise<void> {
  await getDb().delete(mission).where(eq(mission.id, target.id));
}
