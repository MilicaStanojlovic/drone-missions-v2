import { beforeEach, describe, expect, it, vi } from "vitest";
import { CachingMissionDao, type MissionCacheOptions, type MissionDao } from "./mission.cache";
import type { OpenMissionQuery } from "./mission.queries";
import type { Mission, MissionStatus } from "./mission.types";
import type { User } from "@/features/users/user.types";

/**
 * Vitest suite for `mission.cache.ts`, mirroring `CachingMissionDaoTest`
 * case-for-case.
 *
 * The delegate is a hand-rolled fake typed as the `MissionDao` *interface*,
 * not the query module — being able to write this at all, with no database and
 * no framework, is the testability argument for having the interface, exactly
 * as the Java test mocks `MissionDao` rather than a repository.
 *
 * Four Java cases have no counterpart here:
 * - `overdueSweepIsNotCached`, `statusCountsAreNotCached`, `adminSearchIsNotCached`
 *   cover methods this phase has no queries for (Phases 7/8/9). They are
 *   uncached pass-throughs in the source, and the phases that add them add
 *   these cases with them.
 * - the three transaction-synchronisation cases
 *   (`entryRepopulatedDuringATransactionIsClearedOnCompletion`,
 *   `evictionAlsoHappensAfterARollback`, and the "no transaction" variant of
 *   `writeOutsideATransactionEvictsImmediatelyAndDoesNotThrow`) exercise
 *   Spring's `TransactionSynchronizationManager`, which has no equivalent
 *   here — see the "Not ported" section of `mission.cache.ts`. The immediate
 *   eviction those cases share is covered by `saveEvictsTheMission` /
 *   `deleteEvictsTheMission` below.
 *
 * A few cases are additions, each pinning behaviour that is implicit or
 * type-enforced in Java and therefore easy to lose in translation: the
 * open-feed cache key must compare *by value* (record equality there, an
 * explicit canonical key here) and must keep differing queries apart; a list
 * whose entities have expired or been evicted must fall back to the query; a
 * list-only invalidation must leave the entity rows alone; and the `Date`
 * fields have to be cloned, where Java's immutable `Instant` needs no copy.
 *
 * SOURCE: drone-missions-backend/.../data/access/CachingMissionDaoTest.java
 */

const OPTIONS: MissionCacheOptions = {
  ttlMillis: 5 * 60_000,
  maxSize: 100,
  listMaxSize: 50,
  // A fixed clock, like the Java test's `Clock.fixed(...)`: nothing here
  // exercises expiry — `cache.test.ts` does that — so time must not move.
  clock: () => Date.parse("2026-01-01T00:00:00Z"),
};

function user(id: number): User {
  return {
    id,
    username: `user${id}`,
    email: `user${id}@example.com`,
    passwordHash: "hash",
    role: "DESIGNER",
    suspended: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** Mirrors the Java test's `mission(id)` fixture, field for field. */
function mission(id: number): Mission {
  return {
    id,
    name: "Survey",
    description: "desc",
    status: "PUBLISHED",
    moderation: "VISIBLE",
    userId: 7,
    awardedPilotId: null,
    startTime: new Date("2026-02-01T10:00:00Z"),
    endTime: new Date("2026-02-01T12:00:00Z"),
    location: "Novi Sad",
    biddingDeadline: null,
    waypoints: [
      { lat: 45.0, lng: 19.0, altitude: 50.0, action: "PHOTO", hoverDurationSeconds: null },
    ],
    geofence: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    designer: user(7),
  };
}

function openQuery(statuses: MissionStatus[]): OpenMissionQuery {
  return { statuses, location: null, keyword: null, from: null, to: null };
}

/** The `@Mock MissionDao delegate` stand-in: every method a spy, none of them real. */
function fakeDelegate() {
  return {
    findById: vi.fn<MissionDao["findById"]>(async () => undefined),
    findFresh: vi.fn<MissionDao["findFresh"]>(async () => undefined),
    findOpen: vi.fn<MissionDao["findOpen"]>(async () => []),
    findByUserId: vi.fn<MissionDao["findByUserId"]>(async () => []),
    invalidateLists: vi.fn<MissionDao["invalidateLists"]>(),
    save: vi.fn<MissionDao["save"]>(),
    delete: vi.fn<MissionDao["delete"]>(async () => {}),
  };
}

let delegate: ReturnType<typeof fakeDelegate>;
let cache: CachingMissionDao;

beforeEach(() => {
  delegate = fakeDelegate();
  cache = new CachingMissionDao(delegate, OPTIONS);
});

describe("CachingMissionDao — by-id caching", () => {
  it("serves the second read from the cache", async () => {
    delegate.findById.mockResolvedValue(mission(1));

    await cache.findById(1);
    await cache.findById(1);

    expect(delegate.findById).toHaveBeenCalledTimes(1);
  });

  it("never hands back the stored instance", async () => {
    const stored = mission(1);
    delegate.findById.mockResolvedValue(stored);

    const first = await cache.findById(1);
    const second = await cache.findById(1);
    const third = await cache.findById(1);

    expect(second).not.toBe(third);
    expect(second).not.toBe(stored);
    expect(first).not.toBe(second);
    expect(second?.name).toBe("Survey");
    expect(second?.status).toBe("PUBLISHED");
  });

  it("does not let a mutated return value corrupt the cache", async () => {
    delegate.findById.mockResolvedValue(mission(1));
    await cache.findById(1);

    const borrowed = await cache.findById(1);
    borrowed!.name = "tampered";
    borrowed!.status = "CANCELLED";
    // A Date field is mutable in JavaScript where `Instant` is not in Java, so
    // the copy has to clone them — this line is what proves it does.
    borrowed!.startTime!.setTime(0);

    const fresh = await cache.findById(1);
    expect(fresh?.name).toBe("Survey");
    expect(fresh?.status).toBe("PUBLISHED");
    expect(fresh?.startTime).toEqual(new Date("2026-02-01T10:00:00Z"));
  });

  it("does not let a mutation of the delegate's own instance corrupt the cache", async () => {
    const fromDb = mission(1);
    delegate.findById.mockResolvedValue(fromDb);
    await cache.findById(1);

    fromDb.name = "changed after caching";
    fromDb.waypoints![0].altitude = 999;

    const cached = await cache.findById(1);
    expect(cached?.name).toBe("Survey");
    expect(cached?.waypoints?.[0].altitude).toBe(50);
  });

  it("hands out immutable waypoints", async () => {
    delegate.findById.mockResolvedValue(mission(1));
    await cache.findById(1);

    const cached = await cache.findById(1);

    expect(() =>
      cached!.waypoints!.push({
        lat: 1,
        lng: 1,
        altitude: 50,
        action: "PHOTO",
        hoverDurationSeconds: null,
      }),
    ).toThrow(TypeError);
  });

  it("does not cache missing missions", async () => {
    delegate.findById.mockResolvedValue(undefined);

    await cache.findById(99);
    await cache.findById(99);

    expect(delegate.findById).toHaveBeenCalledTimes(2);
  });
});

describe("CachingMissionDao — invalidation", () => {
  it("evicts the mission on save", async () => {
    const m = mission(1);
    delegate.findById.mockResolvedValue(m);
    delegate.save.mockResolvedValue(m);
    await cache.findById(1);

    await cache.save(m);
    await cache.findById(1);

    expect(delegate.findById).toHaveBeenCalledTimes(2);
  });

  it("does not populate the cache from a save's result", async () => {
    const m = mission(1);
    delegate.save.mockResolvedValue(m);
    delegate.findById.mockResolvedValue(m);

    await cache.save(m);
    await cache.findById(1);

    expect(delegate.findById).toHaveBeenCalledTimes(1);
  });

  it("evicts the mission on delete", async () => {
    const m = mission(1);
    delegate.findById.mockResolvedValue(m);
    await cache.findById(1);

    await cache.delete(m);
    await cache.findById(1);

    expect(delegate.findById).toHaveBeenCalledTimes(2);
  });

  it("evicts on findFresh and never populates from it", async () => {
    const m = mission(1);
    delegate.findById.mockResolvedValue(m);
    delegate.findFresh.mockResolvedValue(m);
    await cache.findById(1);

    await cache.findFresh(1);
    await cache.findById(1);

    expect(delegate.findById).toHaveBeenCalledTimes(2);
  });
});

describe("CachingMissionDao — list caching", () => {
  it("serves a repeated feed query from the cache", async () => {
    const query = openQuery(["PUBLISHED", "BIDDING"]);
    delegate.findOpen.mockResolvedValue([mission(1), mission(2)]);

    const first = await cache.findOpen(query);
    const second = await cache.findOpen(query);

    expect(delegate.findOpen).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(second[0].id).toBe(1);
    expect(second[1].id).toBe(2);
  });

  it("preserves feed order through the cache", async () => {
    const query = openQuery(["PUBLISHED"]);
    delegate.findOpen.mockResolvedValue([mission(3), mission(1), mission(2)]);

    await cache.findOpen(query);
    const cached = await cache.findOpen(query);

    expect(cached.map((m) => m.id)).toEqual([3, 1, 2]);
  });

  it("re-runs the query when a member has fallen out of the entity cache", async () => {
    const query = openQuery(["PUBLISHED"]);
    delegate.findOpen.mockResolvedValue([mission(1), mission(2)]);
    delegate.findFresh.mockResolvedValue(mission(2));
    await cache.findOpen(query);

    // `findFresh` evicts one member's entity without touching the id list, so
    // the list can no longer be hydrated and must be reloaded.
    await cache.findFresh(2);
    const reloaded = await cache.findOpen(query);

    expect(delegate.findOpen).toHaveBeenCalledTimes(2);
    expect(reloaded.map((m) => m.id)).toEqual([1, 2]);
  });

  it("caches the my-missions list per user", async () => {
    delegate.findByUserId.mockResolvedValue([mission(1)]);

    await cache.findByUserId(7);
    await cache.findByUserId(7);

    expect(delegate.findByUserId).toHaveBeenCalledTimes(1);
  });

  it("clears the list cache on a write", async () => {
    const query = openQuery(["PUBLISHED"]);
    const m = mission(1);
    delegate.findOpen.mockResolvedValue([m]);
    delegate.save.mockResolvedValue(m);
    await cache.findOpen(query);

    await cache.save(m);
    await cache.findOpen(query);

    expect(delegate.findOpen).toHaveBeenCalledTimes(2);
  });

  it("clears the list cache on invalidateLists but keeps the entities", async () => {
    const query = openQuery(["PUBLISHED"]);
    delegate.findOpen.mockResolvedValue([mission(1)]);
    await cache.findOpen(query);

    cache.invalidateLists();
    await cache.findOpen(query);
    await cache.findById(1);

    expect(delegate.findOpen).toHaveBeenCalledTimes(2);
    // The entity rows survived a list-only invalidation.
    expect(delegate.findById).not.toHaveBeenCalled();
  });
});

/**
 * No Java counterpart: `OpenMissionQuery` is a record there, so value equality
 * as a cache key is free. Here the key is built by hand, so the two halves of
 * that guarantee — equal queries share an entry, different queries do not —
 * are asserted explicitly.
 */
describe("CachingMissionDao — feed cache keys", () => {
  it("treats structurally equal queries as one entry, whatever the status order", async () => {
    delegate.findOpen.mockResolvedValue([mission(1)]);

    await cache.findOpen({
      statuses: ["PUBLISHED", "BIDDING"],
      location: "novi sad",
      keyword: null,
      from: new Date("2026-02-01T00:00:00Z"),
      to: new Date("2026-02-02T00:00:00Z"),
    });
    await cache.findOpen({
      statuses: ["BIDDING", "PUBLISHED"],
      location: "novi sad",
      keyword: null,
      from: new Date("2026-02-01T00:00:00Z"),
      to: new Date("2026-02-02T00:00:00Z"),
    });

    expect(delegate.findOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps queries that differ in any filter apart", async () => {
    delegate.findOpen.mockResolvedValue([mission(1)]);

    await cache.findOpen({ ...openQuery(["PUBLISHED"]), location: "novi sad" });
    await cache.findOpen({ ...openQuery(["PUBLISHED"]), location: "belgrade" });
    await cache.findOpen({ ...openQuery(["PUBLISHED"]), keyword: "novi sad" });
    await cache.findOpen(openQuery(["PUBLISHED"]));

    expect(delegate.findOpen).toHaveBeenCalledTimes(4);
  });

  it("keeps the my-missions key distinct from a feed key", async () => {
    delegate.findByUserId.mockResolvedValue([mission(1)]);
    delegate.findOpen.mockResolvedValue([mission(1)]);

    await cache.findByUserId(7);
    await cache.findOpen(openQuery(["PUBLISHED"]));

    expect(delegate.findByUserId).toHaveBeenCalledTimes(1);
    expect(delegate.findOpen).toHaveBeenCalledTimes(1);
  });
});

describe("CachingMissionDao — concurrency and null ids", () => {
  /**
   * The port of `concurrentReadsOfTheSameMission`. Node has one thread, so the
   * race is between interleaved `await`s rather than eight pool threads, but
   * the property under test is the same: overlapping misses may double-load by
   * design (the loads happen outside any critical section), and the cache ends
   * up holding exactly one entry.
   */
  it("survives overlapping reads of the same mission", async () => {
    delegate.findById.mockImplementation(async () => mission(1));

    const results = await Promise.all(Array.from({ length: 8 }, () => cache.findById(1)));

    expect(delegate.findById.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(results.every((m) => m?.id === 1)).toBe(true);
    expect(cache.entityStats().size).toBe(1);
  });

  it("handles a null id without touching the delegate", async () => {
    await expect(cache.findById(null)).resolves.toBeUndefined();
    await expect(cache.findFresh(null)).resolves.toBeUndefined();

    expect(delegate.findById).not.toHaveBeenCalled();
    expect(delegate.findFresh).not.toHaveBeenCalled();
  });
});
