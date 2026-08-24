import "server-only";
import type { DbHandle } from "@/db/client";
import type { MissionStatus } from "@/db/schema";
import type { Page, PageRequest } from "@/lib/api/paging";
import { TtlCache, formatCacheStats, type CacheStats, type Clock } from "@/lib/cache";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import * as queries from "@/features/missions/mission.queries";
import type { OpenMissionQuery } from "@/features/missions/mission.queries";
import type { Geofence, Mission, MissionWrite, Waypoint } from "@/features/missions/mission.types";

/**
 * Caches mission reads in front of the mission data-access layer. Ports
 * `data.access.CachingMissionDao` — the default-profile implementation wired
 * by `config.MissionCacheConfig` (the `cache-spring` `@Cacheable` variant is
 * not ported; the plan selects this one).
 *
 * A decorator rather than a cache embedded in a service: because every mission
 * read and write already funnels through one data-access contract, this object
 * observes all of them and invalidation cannot be forgotten at a call site —
 * including the bid flows (Phase 3), which write missions without ever going
 * through the mission service.
 *
 * ## What is cached
 * Two caches with different jobs:
 * - **entities** — mission id to a detached copy of the row.
 * - **lists** — a query to the *ordered ids* it returned, never to entities.
 *
 * Storing ids keeps entity freshness in exactly one place and makes list
 * invalidation cheap: a write throws away small id arrays while the expensive
 * rows survive. If a cached id list cannot be fully resolved from the entity
 * cache, the query is simply re-run — one database call, the same cost as no
 * cache at all.
 *
 * ## Copies, in and out
 * The stored object is never handed out, and what a caller hands in is never
 * stored. Both copies are built by naming every field (`shell()` below) rather
 * than spreading, on purpose: adding a field to `Mission` then breaks this
 * file at compile time instead of silently dropping the new field from the
 * copy — the same argument the Java version makes for using the all-args
 * constructor.
 *
 * Where the Java copy shares its `waypoints`/`geofence` because Java records
 * are immutable, this one shares *frozen* copies, which is the same guarantee
 * expressed the way JavaScript can express it. One consequence to know about,
 * identical to the source's: a mission returned from the cache has an immutable
 * `waypoints` array, so mutating it in place throws. Nothing does that today
 * (an edit replaces the array), and failing loudly beats corrupting a shared
 * entry.
 *
 * ## Known limits (both inherited from the source)
 * - **Single instance only.** Two server instances would hold two caches and
 *   neither would see the other's writes, leaving stale reads until the TTL
 *   expires. On Vercel this matters more than it did on one JVM: serverless
 *   instances are many and short-lived, so the cache is best understood as a
 *   per-instance read-through buffer bounded by its TTL. The fix, if that ever
 *   becomes unacceptable, is a shared cache behind this same interface.
 * - **A benign load race.** A reader that misses can have its database load
 *   land after a concurrent writer's eviction, re-inserting a just-superseded
 *   row. It is bounded by the TTL and harmless in practice, because no write
 *   path ever reads from the cache — that is what `findFresh` is for.
 *
 * ## Eviction after a transaction
 * The Java `invalidate()` evicts twice — immediately, and again from an
 * `afterCompletion` transaction synchronisation, so that a concurrent reader
 * repopulating the cache mid-transaction cannot outlive the commit (or the
 * rollback). Drizzle has no ambient transaction manager to register a
 * synchronisation with, so the second eviction is not automatic here: a write
 * that took a `tx` handle still evicts immediately (below), and its caller
 * must call `invalidate(id)` itself once `db.transaction(...)` has returned.
 * `bid.service.ts`'s `accept` does exactly that, and any later transactional
 * flow (mission cancellation, Phase 5) must too. A write with no `tx` needs
 * nothing extra — it commits by the time `save`/`delete` resolves, so its
 * immediate eviction already happens after the commit.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/access/CachingMissionDao.java
 * - drone-missions-backend/.../data/access/MissionDao.java
 * - drone-missions-backend/.../config/MissionCacheConfig.java
 * - drone-missions-backend/.../config/MissionCacheProperties.java
 * - test drone-missions-backend/.../data/access/CachingMissionDaoTest.java
 */

/**
 * The mission data-access contract — the phase-2 slice of `MissionDao`,
 * implemented both by the plain query module and by the decorator below, which
 * is what lets the cache be swapped in without a single call site changing.
 *
 * Every method the source declares is now present: `countByStatus` (Phase 9)
 * was the last one still absent rather than stubbed, and it joins `findOverdue`
 * (Phase 8) and `searchAll` (Phase 7) as an *uncached* pass-through — the form
 * the source gives all three.
 *
 * `findByAwardedPilotId` is not in that group and never was: the source
 * caches it, under its own `OwnerKey("byPilot", …)`, exactly as it caches
 * `findByUserId`. (An earlier revision of this comment listed it among the
 * uncached four — that was wrong about the source, and the method is now
 * implemented below with the list caching the decorator actually gives it.)
 */
export interface MissionDao {
  /** Read-only lookup — may be served from cache. Never pass the result to `save`. */
  findById(id: number): Promise<Mission | undefined>;
  /** Lookup for a flow that will write: always hits the database, evicts any cached copy. */
  findFresh(id: number): Promise<Mission | undefined>;
  /** The open marketplace, filtered, newest-created first. */
  findOpen(query: OpenMissionQuery): Promise<Mission[]>;
  /** Missions created by this user. */
  findByUserId(userId: number): Promise<Mission[]>;
  /** Missions awarded to this pilot. */
  findByAwardedPilotId(pilotId: number): Promise<Mission[]>;
  /**
   * Missions with a pilot on them whose flight window has ended — the overdue
   * sweep's candidates. Never cached, in either source decorator.
   */
  findOverdue(statuses: readonly MissionStatus[], endedBefore: Date): Promise<Mission[]>;
  /**
   * The admin listing — every mission, paged, optionally narrowed by a ready
   * `%…%` pattern. Deliberately *not* cached (see the implementation below).
   */
  searchAll(pattern: string | null, request: PageRequest): Promise<Page<Mission>>;
  /**
   * Mission counts grouped by status — sparse: statuses with no rows are
   * absent, not zero. No moderation filter, so the stats agree with the admin
   * listing (admins see everything). Admin flows only, and never cached.
   */
  countByStatus(): Promise<Partial<Record<MissionStatus, number>>>;
  /**
   * Drop every cached list. For moderation events that change feed membership
   * without a mission write — suspending a designer hides their missions, but
   * the write lands on the users table, which this decorator never observes.
   */
  invalidateLists(): void;
  /**
   * Drop one mission's cached copy (and every cached list, since any write
   * can change membership). The port of `CachingMissionDao.invalidate`, which
   * has no counterpart on the Java *interface* because there it is private
   * and runs a second time from a transaction synchronisation — see the
   * "after a transaction" note in this module's header for why a
   * transactional caller has to call it by hand here.
   */
  invalidate(id: number): void;
  /**
   * Persist a new or modified mission. Invalidates any cached copy.
   *
   * `tx` runs the write on a caller's open transaction (`BidService.accept`);
   * the eviction still happens immediately, and the caller evicts again after
   * its commit via `invalidate`.
   */
  save(input: MissionWrite, tx?: DbHandle): Promise<Mission>;
  /** Delete a mission. Invalidates any cached copy. */
  delete(target: Pick<Mission, "id">): Promise<void>;
}

/** Settings for the mission cache. Mirrors `MissionCacheProperties`. */
export interface MissionCacheOptions {
  /** How long a cached mission or id list stays valid, in milliseconds. */
  ttlMillis: number;
  /** Most missions held at once. */
  maxSize: number;
  /** Most cached query results held at once. */
  listMaxSize: number;
  /** The cache's time source; defaults to the wall clock. */
  clock?: Clock;
}

// --- cache keys ---------------------------------------------------------

/**
 * Builds the list cache's key for one open-feed query.
 *
 * This function has no Java counterpart: there, `OpenMissionQuery` is a record
 * and *is* the key, because record equality compares by value. A JavaScript
 * `Map` compares object keys by reference, so the value equality has to be
 * made explicit — hence a canonical string.
 *
 * "Canonical" is load-bearing, not cosmetic: the statuses are deduplicated and
 * sorted (the source holds them in a `Set`, where order carries no meaning),
 * and the two instants become epoch millis, so two structurally-equal queries
 * always produce one cache entry. Case/whitespace normalisation of `location`
 * and `keyword` happens upstream in the service, exactly as it does in Java —
 * that is what keeps two case-different searches for the same thing from
 * becoming two distinct entries here.
 */
function openQueryKey(query: OpenMissionQuery): string {
  const statuses = [...new Set(query.statuses)].sort();
  return JSON.stringify([
    "open",
    statuses,
    query.location,
    query.keyword,
    query.from === null ? null : query.from.getTime(),
    query.to === null ? null : query.to.getTime(),
  ]);
}

/** The owner/pilot list keys, kept distinct from an open-feed key. Mirrors `OwnerKey`. */
function ownerKey(kind: string, id: number): string {
  return JSON.stringify([kind, id]);
}

// --- defensive copies ---------------------------------------------------

/**
 * A mission shell over the given collections, with every field named.
 *
 * The `Date` fields are cloned rather than shared: `java.time.Instant` is
 * immutable, so sharing one is safe on the Java side, whereas a JavaScript
 * `Date` is mutable and a shared one would let a caller reach into a cached
 * entry with a single `setTime`.
 *
 * `designer` *is* shared, matching the source's decision to share the
 * `designer`/`awardedPilot` relations rather than copy them — copying would
 * cache stale account rows instead, which is worse than the one remaining way
 * a caller can reach into a cached entry (by mutating the user it was handed).
 */
function shell(m: Mission, waypoints: Waypoint[] | null, geofence: Geofence | null): Mission {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    status: m.status,
    moderation: m.moderation,
    userId: m.userId,
    awardedPilotId: m.awardedPilotId,
    startTime: copyDate(m.startTime),
    endTime: copyDate(m.endTime),
    location: m.location,
    biddingDeadline: m.biddingDeadline,
    createdAt: copyDate(m.createdAt),
    updatedAt: copyDate(m.updatedAt),
    waypoints,
    geofence,
    designer: m.designer,
  };
}

function copyDate<T extends Date | null>(value: T): T {
  return (value === null ? null : new Date(value.getTime())) as T;
}

/** The copy that goes into the cache: detached from the caller, collections frozen. */
function toCacheable(m: Mission): Mission {
  const waypoints =
    m.waypoints === null ? null : frozenArray(m.waypoints.map((w) => Object.freeze({ ...w })));
  return Object.freeze(shell(m, waypoints, freezeGeofence(m.geofence)));
}

/** The copy handed to a caller: a fresh shell over parts that are already frozen. */
function fromCache(cached: Mission): Mission {
  return shell(cached, cached.waypoints, cached.geofence);
}

function freezeGeofence(g: Geofence | null): Geofence | null {
  if (g === null) {
    return null;
  }
  if (g.type === "CIRCLE") {
    return Object.freeze({
      type: g.type,
      center: Object.freeze({ ...g.center }),
      radiusMeters: g.radiusMeters,
    });
  }
  return Object.freeze({
    type: g.type,
    points: frozenArray(g.points.map((p) => Object.freeze({ ...p }))),
  });
}

/**
 * `Object.freeze` narrows an array's type to `readonly T[]`, but the fields
 * these land in are declared `T[]`. The cast keeps the same arrangement Java
 * has, where `List.copyOf(...)` is stored in a plain `List<Waypoint>` field:
 * the collection is genuinely immutable at runtime and mutating it fails
 * loudly, rather than the type system forbidding the attempt up front.
 */
function frozenArray<T>(items: T[]): T[] {
  return Object.freeze(items) as T[];
}

// --- the decorator ------------------------------------------------------

export class CachingMissionDao implements MissionDao {
  private readonly delegate: MissionDao;
  private readonly entities: TtlCache<number, Mission>;
  private readonly lists: TtlCache<string, readonly number[]>;

  constructor(delegate: MissionDao, options: MissionCacheOptions) {
    this.delegate = delegate;
    this.entities = new TtlCache({
      ttlMillis: options.ttlMillis,
      maxSize: options.maxSize,
      clock: options.clock,
    });
    this.lists = new TtlCache({
      ttlMillis: options.ttlMillis,
      maxSize: options.listMaxSize,
      clock: options.clock,
    });
  }

  // ---- reads ----

  async findById(id: number | null | undefined): Promise<Mission | undefined> {
    if (id === null || id === undefined) {
      return undefined;
    }
    const cached = this.entities.get(id);
    if (cached !== undefined) {
      return fromCache(cached);
    }
    const loaded = await this.delegate.findById(id);
    // Absent ids are deliberately not cached: they are the 404 path, ids come
    // from the caller so the key space is unbounded, and a negative entry
    // would go stale the moment that mission is created.
    if (loaded !== undefined) {
      this.cacheEntity(loaded);
    }
    return loaded;
  }

  async findFresh(id: number | null | undefined): Promise<Mission | undefined> {
    if (id === null || id === undefined) {
      return undefined;
    }
    // Drop any copy up front so nothing stale is served while the caller mutates.
    this.entities.evict(id);
    return this.delegate.findFresh(id);
  }

  async findOpen(query: OpenMissionQuery): Promise<Mission[]> {
    return this.cachedList(openQueryKey(query), () => this.delegate.findOpen(query));
  }

  async findByUserId(userId: number): Promise<Mission[]> {
    return this.cachedList(ownerKey("byUser", userId), () => this.delegate.findByUserId(userId));
  }

  /**
   * Cached under `"byPilot"`, a key kept distinct from the `"byUser"` one so
   * that a designer who is also the awarded pilot of some mission cannot have
   * one list served for the other. Mirrors the source's two `OwnerKey`
   * records.
   */
  async findByAwardedPilotId(pilotId: number): Promise<Mission[]> {
    return this.cachedList(ownerKey("byPilot", pilotId), () =>
      this.delegate.findByAwardedPilotId(pilotId),
    );
  }

  /**
   * Not cached: a once-a-day sweep gains nothing and would only add
   * invalidation surface. A pure pass-through — it neither reads from nor
   * populates either cache, so the missions it returns are always freshly
   * loaded and no entry is created that a later write would have to evict.
   * Both source decorators (`CachingMissionDao`, `SpringCacheMissionDao`) do
   * exactly this.
   */
  async findOverdue(statuses: readonly MissionStatus[], endedBefore: Date): Promise<Mission[]> {
    return this.delegate.findOverdue(statuses, endedBefore);
  }

  /**
   * Not cached: a rare admin-only view is not worth widening the invalidation
   * surface. Straight through to the delegate, exactly as in the source — the
   * list cache stores *ordered ids per query*, and a paged, pattern-filtered
   * listing would multiply the key space while every mission write already
   * clears the whole list cache anyway.
   *
   * Note the second-order effect this avoids: the entity cache is not
   * populated from here either, so the admin listing never seeds cached rows
   * that the open feed would then serve.
   */
  async searchAll(pattern: string | null, request: PageRequest): Promise<Page<Mission>> {
    return this.delegate.searchAll(pattern, request);
  }

  /**
   * Not cached: a rare admin-only stats view is not worth widening the
   * invalidation surface. The source says exactly that, and here the argument
   * is if anything stronger — the caches hold missions and id lists, so a
   * status→count map has nowhere to live in either of them and caching it
   * would mean a third cache with an invalidation rule of its own, for a
   * dashboard load. Straight to the delegate, so the tiles are always counted
   * against the current table rather than a copy a write forgot to clear.
   */
  async countByStatus(): Promise<Partial<Record<MissionStatus, number>>> {
    return this.delegate.countByStatus();
  }

  /**
   * Feed membership changed without a mission write (a designer was suspended
   * or reactivated). Only the id arrays go; the entity rows are still correct.
   */
  invalidateLists(): void {
    this.lists.clear();
  }

  /**
   * Drop one mission's cached copy and every cached list. Public only so a
   * transactional caller can re-evict after its commit — the hand-run half of
   * the source's `afterCompletion` synchronisation.
   */
  invalidate(id: number): void {
    this.evictNow(id);
  }

  // ---- writes ----

  async save(input: MissionWrite, tx?: DbHandle): Promise<Mission> {
    const saved = await this.delegate.save(input, tx);
    // Never cache `saved`: read-through only, mirroring the source's refusal to
    // store a row whose update timestamp the database may still be settling.
    this.evictNow(saved.id);
    return saved;
  }

  async delete(target: Pick<Mission, "id">): Promise<void> {
    const id = target.id;
    await this.delegate.delete(target);
    this.evictNow(id);
  }

  // ---- invalidation ----

  private evictNow(id: number | null | undefined): void {
    if (id !== null && id !== undefined) {
      this.entities.evict(id);
    }
    // Any write can change which missions a query returns, so membership
    // indexes all go. They are only id arrays; the costly entity rows are
    // untouched.
    this.lists.clear();
  }

  // ---- helpers ----

  private async cachedList(key: string, loader: () => Promise<Mission[]>): Promise<Mission[]> {
    const cachedIds = this.lists.get(key);
    if (cachedIds !== undefined) {
      const hydrated = this.hydrate(cachedIds);
      if (hydrated !== null) {
        return hydrated;
      }
    }
    const loaded = await loader();
    const ids: number[] = [];
    for (const m of loaded) {
      this.cacheEntity(m);
      ids.push(m.id);
    }
    this.lists.put(key, Object.freeze(ids));
    return loaded;
  }

  /** Rebuild a list from the entity cache, or null if any member is no longer cached. */
  private hydrate(ids: readonly number[]): Mission[] | null {
    const result: Mission[] = [];
    for (const id of ids) {
      const cached = this.entities.get(id);
      if (cached === undefined) {
        return null;
      }
      result.push(fromCache(cached));
    }
    return result;
  }

  private cacheEntity(m: Mission): void {
    if (m.id !== null && m.id !== undefined) {
      this.entities.put(m.id, toCacheable(m));
    }
  }

  // ---- observability ----

  /**
   * Reclaims expired entries early and makes the hit rate visible without
   * extra tooling. Ports `sweepAndReport()`; the `@Scheduled` trigger itself
   * is not ported here — the scheduler (node-cron) is set up with the overdue
   * sweep in Phase 8, and this is a memory optimisation, never a correctness
   * requirement (expiry is enforced lazily on every read).
   */
  sweepAndReport(): void {
    const purged = this.entities.purgeExpired() + this.lists.purgeExpired();
    logger.info(
      {
        entities: formatCacheStats(this.entities.stats()),
        lists: formatCacheStats(this.lists.stats()),
        purged,
      },
      "mission cache swept",
    );
  }

  /** Exposed for tests and debugging. */
  entityStats(): CacheStats {
    return this.entities.stats();
  }

  /** Exposed for tests and debugging. */
  listStats(): CacheStats {
    return this.lists.stats();
  }
}

// --- wiring (ports MissionCacheConfig) ----------------------------------

/**
 * The uncached data-access layer: the query module, viewed as a `MissionDao`.
 * The counterpart of `JpaMissionDao`, whose `invalidateLists()` is likewise an
 * empty method — it holds no cache, so there is nothing to invalidate.
 */
const uncachedMissionDao: MissionDao = {
  findById: queries.findById,
  findFresh: queries.findFresh,
  findOpen: queries.findOpen,
  findByUserId: queries.findByUserId,
  findByAwardedPilotId: queries.findByAwardedPilotId,
  findOverdue: queries.findOverdue,
  searchAll: queries.searchAll,
  countByStatus: queries.countByStatus,
  invalidateLists: () => {},
  invalidate: () => {},
  save: queries.save,
  delete: queries.deleteMission,
};

const globalForMissionDao = globalThis as unknown as { __droneMissionsMissionDao?: MissionDao };

/**
 * The process-wide mission DAO every service must go through — the caching
 * decorator over the query module, or the query module itself when
 * `MISSION_CACHE_ENABLED=false`.
 *
 * Turning the cache off is not a runtime flag: the decorator is simply never
 * constructed, so the disabled path costs nothing at all — no branch on every
 * call, and no no-op implementation to maintain. That is exactly how
 * `MissionCacheConfig` handles `app.cache.mission.enabled=false`.
 *
 * Built lazily and cached on `globalThis` for the same two reasons
 * `src/db/client.ts` is: importing this module must not do work (nor log) at
 * import time, and Next's dev-mode hot reload must not silently leave every
 * request talking to a fresh, empty cache.
 */
export function getMissionDao(): MissionDao {
  if (!globalForMissionDao.__droneMissionsMissionDao) {
    globalForMissionDao.__droneMissionsMissionDao = createMissionDao();
  }
  return globalForMissionDao.__droneMissionsMissionDao;
}

function createMissionDao(): MissionDao {
  if (!env.MISSION_CACHE_ENABLED) {
    logger.info("mission cache: disabled, using the uncached data-access layer");
    return uncachedMissionDao;
  }
  // Announced at startup for the same reason the source announces it: both
  // paths serve identical responses, so without this line a misconfiguration
  // is invisible.
  logger.info(
    {
      ttlMillis: env.MISSION_CACHE_TTL_MS,
      entities: env.MISSION_CACHE_MAX_SIZE,
      lists: env.MISSION_CACHE_LIST_MAX_SIZE,
    },
    "mission cache: CachingMissionDao (hand-written TtlCache)",
  );
  return new CachingMissionDao(uncachedMissionDao, {
    ttlMillis: env.MISSION_CACHE_TTL_MS,
    maxSize: env.MISSION_CACHE_MAX_SIZE,
    listMaxSize: env.MISSION_CACHE_LIST_MAX_SIZE,
  });
}
