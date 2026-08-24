import "server-only";

/**
 * A small hand-written cache: time-to-live expiry, a size bound, and hit/miss
 * counters. Ports `data.access.TtlCache` (+ `data.access.CacheStats`).
 *
 * Deliberately free of any third-party library — it is a plain data structure,
 * exactly as the Java original is.
 *
 * ## Expiry
 * Expiry is checked lazily on read, so a stale entry is never served even if
 * nothing ever sweeps. `purgeExpired()` only reclaims memory sooner; it is an
 * optimisation, never a correctness requirement.
 *
 * ## Bounding: admission, not eviction
 * When the cache is full, `put` first drops expired entries; if it is still
 * full the *new* value is refused and counted as a rejection. Existing entries
 * are never discarded to make room.
 *
 * This is a deliberate simplification, not an oversight (the Java class
 * argues it at length): refusing admission is O(1), self-heals as entries
 * expire, and has a useful security property — a caller flooding the cache
 * with junk keys cannot evict the hot entries.
 *
 * ## Discrepancy from the phase plan (intentional, noted for the record)
 * `plans/PLAN-missions-core.md` suggests backing this with `lru-cache`. It is
 * not used, because `lru-cache` implements the *opposite* bounding policy:
 * when full it evicts the least-recently-used entry to admit the newcomer,
 * which is precisely the behaviour `TtlCacheTest` pins down as wrong here
 * (`whenFullTheNewEntryIsRejectedAndExistingEntriesSurvive`). It also owns its
 * own time source, so the injectable clock the TTL tests drive — and the exact
 * "expires at `now >= expiresAt`, live one millisecond earlier" boundary —
 * could not be reproduced. The source wins over the plan, so this stays a
 * hand-written `Map`, and no dependency is added.
 *
 * ## Concurrency
 * The Java version documents a `ConcurrentHashMap`, lock-free reads, and a
 * deliberate refusal to load inside the map (which would serialise unrelated
 * keys across a database round trip). Node runs this on one thread, so none of
 * that machinery is needed — but the *shape* is kept: `get` never loads, so
 * callers miss, `await` their load outside any critical section, then `put`.
 * Two concurrent callers may therefore load the same key; the load is
 * idempotent, so this is harmless, and it is the same benign double-load the
 * Java class accepts.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/access/TtlCache.java
 * - drone-missions-backend/.../data/access/CacheStats.java
 * - test drone-missions-backend/.../data/access/TtlCacheTest.java
 */

/**
 * The cache's time source, in epoch milliseconds — the port of injecting a
 * `java.time.Clock` and calling `clock.millis()`. Tests hand in a hand-cranked
 * clock so TTL can be exercised exactly, and without sleeping.
 */
export type Clock = () => number;

/**
 * An immutable snapshot of a {@link TtlCache}'s counters. Mirrors the
 * `CacheStats` record — it exists so the "this improves performance" claim is
 * observable rather than assumed.
 *
 * `hitRatio` is a plain field rather than the record's `hitRatio()` method:
 * a snapshot is already a frozen value, so computing it once at snapshot time
 * is equivalent.
 */
export interface CacheStats {
  /** Reads served from the cache. */
  readonly hits: number;
  /** Reads that found nothing (including entries found expired). */
  readonly misses: number;
  /** Values actually stored. */
  readonly puts: number;
  /** Entries removed explicitly, by invalidation. */
  readonly evictions: number;
  /** Entries removed because their TTL had passed. */
  readonly expirations: number;
  /** Puts refused because the cache was full — see {@link TtlCache}. */
  readonly rejections: number;
  /** Entries currently held, including any not yet purged. */
  readonly size: number;
  /** Share of reads served from cache, 0 when nothing has been read yet. */
  readonly hitRatio: number;
}

/** Mirrors `CacheStats.toString()` — the one-line form the sweep reporter logs. */
export function formatCacheStats(stats: CacheStats): string {
  return (
    `hits=${stats.hits} misses=${stats.misses} ratio=${stats.hitRatio.toFixed(2)} ` +
    `size=${stats.size} evictions=${stats.evictions} expired=${stats.expirations} ` +
    `rejected=${stats.rejections}`
  );
}

export interface TtlCacheOptions {
  /** How long an entry stays valid after being stored, in milliseconds. */
  ttlMillis: number;
  /** The most entries held at once; further puts are rejected. */
  maxSize: number;
  /** The time source; defaults to the wall clock. */
  clock?: Clock;
}

interface Entry<V> {
  readonly value: V;
  readonly expiresAtEpochMilli: number;
}

/**
 * Keys are restricted to primitives because a JavaScript `Map` compares object
 * keys by reference, where the Java version relies on record value equality
 * (an `OpenMissionQuery` *is* the key there). Callers therefore build a stable
 * string key from their query object — see `mission.cache.ts`.
 */
export class TtlCache<K extends string | number, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly ttlMillis: number;
  private readonly maxSize: number;
  private readonly clock: Clock;

  private hits = 0;
  private misses = 0;
  private puts = 0;
  private evictions = 0;
  private expirations = 0;
  private rejections = 0;

  constructor({ ttlMillis, maxSize, clock = Date.now }: TtlCacheOptions) {
    // Mirrors the constructor's two IllegalArgumentExceptions: a nonsensical
    // setting fails at construction rather than misbehaving at runtime.
    if (!Number.isFinite(ttlMillis) || ttlMillis <= 0) {
      throw new Error(`ttl must be positive, was ${ttlMillis}ms`);
    }
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new Error(`maxSize must be positive, was ${maxSize}`);
    }
    this.ttlMillis = ttlMillis;
    this.maxSize = maxSize;
    this.clock = clock;
  }

  /** The cached value, or `undefined` if absent or expired (`Optional.empty()`). */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    // `now >= expiresAt`, not `>`: an entry is dead exactly at its TTL, which
    // is the boundary `TtlCacheTest` pins down to the millisecond.
    if (this.clock() >= entry.expiresAtEpochMilli) {
      this.entries.delete(key);
      this.expirations++;
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  /** Store a value, unless the cache is full of live entries. */
  put(key: K, value: V): void {
    // `has`, deliberately without an expiry check — an expired-but-unpurged
    // entry still counts as present, so overwriting its key is always allowed.
    if (this.entries.size >= this.maxSize && !this.entries.has(key)) {
      this.purgeExpired();
      if (this.entries.size >= this.maxSize) {
        this.rejections++;
        return;
      }
    }
    this.entries.set(key, { value, expiresAtEpochMilli: this.clock() + this.ttlMillis });
    this.puts++;
  }

  /** Drop one entry. Does nothing if it was not cached. */
  evict(key: K): void {
    if (this.entries.delete(key)) {
      this.evictions++;
    }
  }

  /** Drop every entry. Counters are left alone so lifetime statistics stay meaningful. */
  clear(): void {
    this.evictions += this.entries.size;
    this.entries.clear();
  }

  /**
   * Remove entries whose TTL has passed.
   *
   * @returns how many were removed
   */
  purgeExpired(): number {
    const now = this.clock();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAtEpochMilli) {
        this.entries.delete(key);
        removed++;
      }
    }
    this.expirations += removed;
    return removed;
  }

  /** Entries currently held, including any expired but not yet purged. */
  size(): number {
    return this.entries.size;
  }

  /** A point-in-time snapshot of the counters. */
  stats(): CacheStats {
    const reads = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      puts: this.puts,
      evictions: this.evictions,
      expirations: this.expirations,
      rejections: this.rejections,
      size: this.entries.size,
      hitRatio: reads === 0 ? 0 : this.hits / reads,
    };
  }
}
