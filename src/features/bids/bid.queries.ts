import "server-only";
import { and, count, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { dbFor, getDb, type DbHandle } from "@/db/client";
import { bid, mission, users, type BidStatus } from "@/db/schema";
import type { Bid } from "./bid.types";

/**
 * The bid data-access layer (replaces `data.repository.BidRepository`).
 *
 * Every read below joins the mission and the pilot, because `BidMapper` reads
 * `bid.getMission().getName()` and `bid.getPilot().getUsername()` off the JPA
 * relations — its own javadoc calls out that "the per-bid lookups this used to
 * do are gone". Materialising the two names in the same statement is what
 * keeps that true here: without the join the mapper would be back to an N+1 of
 * mission/user lookups, which is exactly the shape the source removed.
 *
 * The two aggregate projections `volume()` / `topMissionsByBids()` (the admin
 * overview) are the exception: they join nothing they do not need and return
 * their own narrow shapes rather than `Bid`s, exactly as the source's
 * `BidVolume` / `MissionBidCount` projections do.
 *
 * ## Running inside a transaction
 * `findById`, `findByMissionAndStatus` and `save` take an optional `tx`
 * handle. `BidService.accept` is `@Transactional` in the source, where the
 * repository calls join the ambient transaction invisibly; Drizzle has no
 * ambient transaction, so the handle is threaded through explicitly and
 * defaults to the pool when absent (see `dbFor` in `src/db/client.ts`). Every
 * read a transactional write depends on — including `save`'s own read-back —
 * must run on the same handle, or it would be answered by a different
 * connection that cannot see the uncommitted rows.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/repository/BidRepository.java
 * - drone-missions-backend/.../data/model/Bid.java
 * - drone-missions-backend/.../web/mapper/bid/BidMapper.java
 */

/**
 * What `save()` accepts — the counterpart of handing a `Bid` entity to Spring
 * Data's `save()`, which inserts when the id is absent and merges every column
 * when it is present.
 *
 * A loaded `Bid` is assignable to this type as-is, so `BidService.place`'s
 * "find the pilot's bid or build a fresh one, set amount/message, save" flow
 * ports over unchanged. A brand-new bid omits `id` (identity-generated) and
 * the timestamps (stamped by `save()`, mirroring `@CreationTimestamp` /
 * `@UpdateTimestamp`).
 *
 * It lives in this module rather than in `bid.types.ts` for the reason that
 * file documents about itself: it is deliberately isomorphic, imported by the
 * bids panel and `/my-bids` in the browser. A DAO write shape is server-side
 * only, so it belongs behind `import "server-only"` — the same placement
 * precedent as `OpenMissionQuery` in `mission.queries.ts`.
 */
export interface BidWrite {
  id?: number | null;
  /** The `mission` relation's FK column; `NOT NULL` (V8). */
  missionId: number;
  /** The `pilot` relation's FK column; `NOT NULL` (V8). */
  pilotId: number;
  amount: number;
  message: string | null;
  status: BidStatus;
}

/** The row shape every read below produces before narrowing. */
type JoinedRow = {
  bid: typeof bid.$inferSelect;
  mission: { id: number; name: string | null };
  pilot: { id: number; username: string };
};

/**
 * Narrows a joined row into a `Bid`.
 *
 * The only conversion is `amount`: Drizzle types a `numeric` column as
 * `string`, because `postgres.js` hands back the decimal text rather than
 * risk a lossy `Number` on an arbitrary-precision type. `Bid.amount` is a
 * `number`, which for `numeric(12, 2)` is lossless — see the type's own note —
 * so the narrowing happens once, here, and no consumer ever sees the string.
 */
function toBid(row: JoinedRow): Bid {
  return {
    ...row.bid,
    amount: Number(row.bid.amount),
    mission: row.mission,
    pilot: row.pilot,
  };
}

/**
 * The base read: every bid column plus the two names the mapper needs.
 *
 * INNER joins, unlike the LEFT join `mission.queries.ts` uses for a mission's
 * designer: `bid.mission_id` and `bid.pilot_id` are both `NOT NULL` with
 * foreign keys (V8), so neither relation can be absent — and the Java entity
 * agrees, declaring both `@JoinColumn(nullable = false)`. Selecting only
 * `mission.id`/`mission.name` also keeps a mission's two `jsonb` flight-plan
 * columns out of every bid list, and taking only `id`/`username` from `users`
 * means no password hash is ever loaded into a bid.
 */
function selectBids(tx?: DbHandle) {
  return dbFor(tx)
    .select({
      bid: getTableColumns(bid),
      mission: { id: mission.id, name: mission.name },
      pilot: { id: users.id, username: users.username },
    })
    .from(bid)
    .innerJoin(mission, eq(bid.missionId, mission.id))
    .innerJoin(users, eq(bid.pilotId, users.id));
}

/**
 * Look up one bid by id. Mirrors `JpaRepository.findById` as
 * `BidService.getBidOrThrow` calls it (`Optional.empty()` becomes
 * `undefined`).
 */
export async function findById(id: number, tx?: DbHandle): Promise<Bid | undefined> {
  const [row] = await selectBids(tx).where(eq(bid.id, id));
  return row ? toBid(row) : undefined;
}

/**
 * Every bid on a mission with a given status. Mirrors
 * `findByMission_IdAndStatus` — the accept flow's "who else is still
 * pending?" lookup, which is the one place a status is queried directly.
 *
 * No `ORDER BY`, because the derived Spring Data query declares none: the
 * losers are all rejected, so the order they come back in is not observable.
 * (`findByMissionOrderByCreatedAtDesc` above adds an id tiebreaker precisely
 * because *its* order is displayed; this one's is not.)
 */
export async function findByMissionAndStatus(
  missionId: number,
  status: BidStatus,
  tx?: DbHandle,
): Promise<Bid[]> {
  const rows = await selectBids(tx).where(
    and(eq(bid.missionId, missionId), eq(bid.status, status)),
  );
  return rows.map(toBid);
}

/**
 * The one bid a given pilot has on a given mission, if any. Mirrors
 * `findByMission_IdAndPilot_Id`.
 *
 * At most one row can match — `bid_mission_pilot_unique` (V8) is what makes
 * the singular return honest, and it is the same constraint that turns
 * re-bidding into an update rather than a second row.
 */
export async function findByMissionAndPilot(
  missionId: number,
  pilotId: number,
): Promise<Bid | undefined> {
  const [row] = await selectBids().where(
    and(eq(bid.missionId, missionId), eq(bid.pilotId, pilotId)),
  );
  return row ? toBid(row) : undefined;
}

/**
 * Every bid on a mission, newest first. Mirrors
 * `findByMission_IdOrderByCreatedAtDesc` — the designer's view of their own
 * mission.
 *
 * Note: `id DESC` is added as a tiebreaker, exactly as
 * `notification.queries.ts` does. The source orders by `created_at` alone,
 * which leaves rows sharing a timestamp in an unspecified order; since ids are
 * monotonic, breaking the tie by id keeps "newest first" true rather than
 * arbitrary for bids placed inside the same clock tick, without reordering any
 * two rows the source already ordered.
 *
 * `tx` runs the read on a caller's open transaction — `MissionService.cancel`
 * rejects every outstanding bid in the same transaction that cancels the
 * mission, and must therefore see the rows as that transaction left them. The
 * source gets this from `@Transactional` binding the repository to the
 * ambient transaction; here the handle is passed explicitly.
 */
export async function findByMissionOrderByCreatedAtDesc(
  missionId: number,
  tx?: DbHandle,
): Promise<Bid[]> {
  const rows = await selectBids(tx)
    .where(eq(bid.missionId, missionId))
    .orderBy(desc(bid.createdAt), desc(bid.id));
  return rows.map(toBid);
}

/**
 * Every bid one pilot has placed, newest first. Mirrors
 * `findByPilot_IdOrderByCreatedAtDesc` — the `/my-bids` history. Same id
 * tiebreaker as above.
 *
 * No moderation filter, matching the source: a pilot keeps seeing their own
 * bid even if the mission it is on has since been hidden.
 */
export async function findByPilotOrderByCreatedAtDesc(pilotId: number): Promise<Bid[]> {
  const rows = await selectBids()
    .where(eq(bid.pilotId, pilotId))
    .orderBy(desc(bid.createdAt), desc(bid.id));
  return rows.map(toBid);
}

/**
 * Platform-wide bid totals — the return of the source's `BidVolume`
 * projection, which keeps the aggregate typed instead of an `Object[]` row.
 *
 * `totalAmount` is a `number` here for the same reason `Bid.amount` is: the
 * column is `numeric(12, 2)`, whose sum is exactly representable in a double
 * long before the platform's bids could add up to 2^53 cents, and the source's
 * `BigDecimal` is written by Jackson as a JSON number anyway. The narrowing
 * happens once, in `volume()`, exactly as `toBid` does it for a single bid.
 */
export interface BidVolume {
  count: number;
  totalAmount: number;
}

/** One bar of the overview's bids-per-mission chart. Mirrors `MissionBidCount`. */
export interface MissionBidCount {
  /**
   * Nullable because `mission.name` is (`varchar(255)`, no NOT NULL in V1) —
   * the same nullability `Mission.name` and `bid.types.ts` already carry.
   */
  name: string | null;
  total: number;
}

/**
 * How many live bids exist and what they add up to. Mirrors
 * `BidRepository.volume()`:
 *
 * ```
 * select count(b) as count, coalesce(sum(b.amount), 0) as totalAmount from Bid b
 * ```
 *
 * Any status counts, and a withdrawn bid is a deleted row (see `deleteBid`
 * below), so this is live bids only — the javadoc's own words.
 *
 * The `coalesce` is what makes an empty table answer `0` rather than SQL NULL,
 * and it is load-bearing: an aggregate with no `GROUP BY` always returns
 * exactly one row, so without it the caller would get `null` instead of a
 * total. `sum(numeric)` comes back from postgres.js as decimal *text* (the
 * driver refuses to narrow an arbitrary-precision type), which is why the
 * `Number()` sits here and no consumer ever sees the string.
 */
export async function volume(): Promise<BidVolume> {
  const [row] = await getDb()
    .select({
      count: count(),
      totalAmount: sql<string>`coalesce(sum(${bid.amount}), 0)`,
    })
    .from(bid);
  return { count: row?.count ?? 0, totalAmount: Number(row?.totalAmount ?? 0) };
}

/**
 * The most-bid-on missions, most bids first, capped at `limit`. Mirrors
 * `BidRepository.topMissionsByBids(Pageable)`, where the cap arrives as a
 * `PageRequest.of(0, TOP_MISSIONS)` — a plain `limit` here, since the source
 * only ever asks for the first page and never reads a total.
 *
 * Zero-bid missions are naturally absent (the count is over `bid` rows), and
 * there is no moderation filter: the overview is admin-only and its status
 * counts include hidden missions too, so the chart matching them is the
 * source's deliberate choice.
 *
 * The join is INNER, like `selectBids`, because `bid.mission_id` is `NOT NULL`
 * with an FK (V8) — and `group by mission.id, mission.name` groups by the id,
 * not the name, so two missions that happen to share a name stay two bars,
 * exactly as the JPQL does it.
 *
 * `mission.id DESC` is added as a tiebreaker, the same way this module's
 * `created_at` orderings are: the source leaves missions with equal counts in
 * an unspecified order, which the cap makes observable (which of the tied
 * missions gets the last bar). Breaking the tie by id keeps the answer stable
 * across calls without reordering any two rows the source already ordered.
 */
export async function topMissionsByBids(limit: number): Promise<MissionBidCount[]> {
  return getDb()
    .select({ name: mission.name, total: count() })
    .from(bid)
    .innerJoin(mission, eq(bid.missionId, mission.id))
    .groupBy(mission.id, mission.name)
    .orderBy(desc(count()), desc(mission.id))
    .limit(limit);
}

/**
 * Persist a new or modified bid and return it with its mission and pilot
 * resolved. Mirrors `bidRepository.save(bid)` over Spring Data's `save()`: an
 * absent id inserts, a present id merges every column of the supplied object
 * over the row.
 *
 * The insert relies on `bid_mission_pilot_unique` only as a backstop, not as
 * the upsert mechanism — `BidService.place` decides between insert and update
 * by first looking the pilot's bid up with `findByMissionAndPilot`, exactly as
 * the source does, so a second bid from the same pilot arrives here *with* an
 * id and takes the UPDATE branch. If two concurrent places race past that
 * lookup, the constraint rejects the loser rather than letting a duplicate
 * through; there is no `ON CONFLICT` clause here because the source has no
 * equivalent, and silently swallowing the race would change behaviour.
 *
 * `amount` crosses as its decimal text: the column is `numeric(12, 2)` and
 * Drizzle types it `string`, so Postgres applies the column's scale itself —
 * the same rounding the JDBC driver leaves to the database for a `BigDecimal`.
 *
 * The timestamps are stamped here because neither column has a database
 * default (see `V8__create_bid_table.sql`); Hibernate's `@CreationTimestamp` /
 * `@UpdateTimestamp` do it on the Java side, and `created_at` is
 * `updatable = false`, so an update never rewrites it.
 *
 * The saved row is re-read through the joins instead of being assembled from
 * the write: `returning()` yields the bid columns only, and every caller (the
 * mapper above all) needs the mission and pilot names attached.
 */
export async function save(input: BidWrite, tx?: DbHandle): Promise<Bid> {
  const now = new Date();
  const columns = {
    missionId: input.missionId,
    pilotId: input.pilotId,
    amount: String(input.amount),
    message: input.message,
    status: input.status,
  };

  let savedId: number;
  if (input.id === undefined || input.id === null) {
    const [inserted] = await dbFor(tx)
      .insert(bid)
      .values({ ...columns, createdAt: now, updatedAt: now })
      .returning({ id: bid.id });
    savedId = inserted.id;
  } else {
    const [updated] = await dbFor(tx)
      .update(bid)
      .set({ ...columns, updatedAt: now })
      .where(eq(bid.id, input.id))
      .returning({ id: bid.id });
    if (!updated) {
      // The row vanished between the caller's read and this write. Hibernate
      // fails the same way (merging a detached entity whose row is gone), and
      // no caller can recover, so this stays an unmapped error rather than one
      // of the HTTP-mapped `AppError` subclasses — the identical choice
      // `mission.queries.ts`'s `save` makes.
      throw new Error(`Bid ${input.id} no longer exists`);
    }
    savedId = updated.id;
  }

  // On the caller's handle: inside a transaction the row this just wrote is
  // invisible to every other connection until commit.
  const saved = await findById(savedId, tx);
  if (!saved) {
    throw new Error(`Bid ${savedId} vanished immediately after being saved`);
  }
  return saved;
}

/**
 * Delete a bid — how a withdrawal is recorded, since `BidService.withdraw`
 * removes the row rather than moving it to a status (which is why
 * `BidRepository.volume()`'s javadoc can say it counts live bids only).
 * Mirrors `bidRepository.delete(bid)`, which takes the loaded entity and uses
 * only its id.
 *
 * Named `deleteBid` rather than `delete` only because `delete` is a reserved
 * word and cannot name a function declaration — the same reason
 * `mission.queries.ts` has `deleteMission`.
 */
export async function deleteBid(target: Pick<Bid, "id">): Promise<void> {
  await getDb().delete(bid).where(eq(bid.id, target.id));
}
