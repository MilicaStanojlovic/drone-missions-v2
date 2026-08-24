import { describe, expect, it } from "vitest";
import { TtlCache, formatCacheStats, type Clock } from "@/lib/cache";

/**
 * Vitest suite for `src/lib/cache.ts`, mirroring `TtlCacheTest` case-for-case.
 *
 * No database and no framework, so this runs anywhere. Time is driven by a
 * mutable clock rather than a real sleep, which keeps the TTL assertions exact
 * and instant — the same choice the Java test makes with a hand-cranked
 * `java.time.Clock`.
 *
 * SOURCE: drone-missions-backend/.../data/access/TtlCacheTest.java
 */

const TTL_MS = 5 * 60_000; // Duration.ofMinutes(5)

/** A hand-cranked clock. The port of the Java test's `MutableClock`. */
function mutableClock(start = Date.parse("2026-01-01T00:00:00Z")) {
  let now = start;
  const clock: Clock = () => now;
  return {
    clock,
    advance(millis: number) {
      now += millis;
    },
  };
}

function cacheOf(maxSize: number, clock: Clock) {
  return new TtlCache<string, string>({ ttlMillis: TTL_MS, maxSize, clock });
}

describe("TtlCache", () => {
  it("misses on an unknown key", () => {
    const { clock } = mutableClock();
    const cache = cacheOf(10, clock);

    expect(cache.get("absent")).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  it("hits after a put", () => {
    const { clock } = mutableClock();
    const cache = cacheOf(10, clock);
    cache.put("k", "v");

    expect(cache.get("k")).toBe("v");
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().puts).toBe(1);
  });

  it("keeps an entry live one millisecond before expiry", () => {
    const { clock, advance } = mutableClock();
    const cache = cacheOf(10, clock);
    cache.put("k", "v");

    advance(TTL_MS - 1);

    expect(cache.get("k")).toBe("v");
  });

  it("expires an entry exactly at the TTL and removes it", () => {
    const { clock, advance } = mutableClock();
    const cache = cacheOf(10, clock);
    cache.put("k", "v");

    advance(TTL_MS);

    expect(cache.get("k")).toBeUndefined();
    expect(cache.size()).toBe(0);
    expect(cache.stats().expirations).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it("evicts and counts", () => {
    const { clock } = mutableClock();
    const cache = cacheOf(10, clock);
    cache.put("k", "v");

    cache.evict("k");

    expect(cache.get("k")).toBeUndefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it("counts nothing when evicting an absent key", () => {
    const { clock } = mutableClock();
    const cache = cacheOf(10, clock);

    cache.evict("never-there");

    expect(cache.stats().evictions).toBe(0);
  });

  /** The decision that separates this from an LRU: a full cache refuses the newcomer. */
  it("rejects the new entry when full and keeps the existing ones", () => {
    const { clock } = mutableClock();
    const cache = cacheOf(2, clock);
    cache.put("a", "1");
    cache.put("b", "2");

    cache.put("c", "3");

    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBe("2");
    expect(cache.stats().rejections).toBe(1);
    expect(cache.size()).toBe(2);
  });

  it("allows overwriting an existing key even when full", () => {
    const { clock } = mutableClock();
    const cache = cacheOf(2, clock);
    cache.put("a", "1");
    cache.put("b", "2");

    cache.put("a", "updated");

    expect(cache.get("a")).toBe("updated");
    expect(cache.stats().rejections).toBe(0);
  });

  it("lets expired entries free space for new ones", () => {
    const { clock, advance } = mutableClock();
    const cache = cacheOf(2, clock);
    cache.put("a", "1");
    cache.put("b", "2");

    advance(TTL_MS);
    cache.put("c", "3");

    expect(cache.get("c")).toBe("3");
    expect(cache.stats().rejections).toBe(0);
  });

  it("purges only expired entries", () => {
    const { clock, advance } = mutableClock();
    const cache = cacheOf(10, clock);
    cache.put("old", "1");
    advance(TTL_MS - 60_000);
    cache.put("new", "2");

    advance(60_000);
    const purged = cache.purgeExpired();

    expect(purged).toBe(1);
    expect(cache.size()).toBe(1);
    expect(cache.get("new")).toBe("2");
  });

  it("empties the cache on clear but keeps lifetime counters", () => {
    const { clock } = mutableClock();
    const cache = cacheOf(10, clock);
    cache.put("k", "v");
    cache.get("k");

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().puts).toBe(1);
  });

  it("reports a hit ratio that reflects reads", () => {
    const { clock } = mutableClock();
    const cache = cacheOf(10, clock);
    cache.put("k", "v");
    cache.get("k");
    cache.get("k");
    cache.get("absent");

    expect(cache.stats().hitRatio).toBe(2 / 3);
  });

  it("reports a zero hit ratio before any read", () => {
    const { clock } = mutableClock();
    expect(cacheOf(10, clock).stats().hitRatio).toBe(0);
  });

  it("rejects non-positive configuration", () => {
    const { clock } = mutableClock();
    expect(() => new TtlCache<string, string>({ ttlMillis: 0, maxSize: 10, clock })).toThrow();
    expect(() => new TtlCache<string, string>({ ttlMillis: TTL_MS, maxSize: 0, clock })).toThrow();
  });
});

/**
 * No Java counterpart as a test, but `CacheStats.toString()` is what the sweep
 * reporter logs, so the one-line form is pinned here.
 */
describe("formatCacheStats", () => {
  it("renders the counters in the source's one-line form", () => {
    const { clock } = mutableClock();
    const cache = cacheOf(10, clock);
    cache.put("k", "v");
    cache.get("k");
    cache.get("absent");

    expect(formatCacheStats(cache.stats())).toBe(
      "hits=1 misses=1 ratio=0.50 size=1 evictions=0 expired=0 rejected=0",
    );
  });
});
