import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { users } from "@/db/schema";
import type { UserRole } from "@/db/schema";
import * as queries from "./user.queries";
import { UserNotFoundError } from "./user.queries";

/**
 * Live-DB suite for the user data-access layer.
 *
 * `user.queries.ts` is the half of the admin user surface that is *only* SQL:
 * `search` is the ported `UserRepository.search` (a null role meaning
 * "everyone", `created_at` DESC, a `LIMIT`/`OFFSET` slice beside a separate
 * `count`), and `setSuspended` is the targeted `UPDATE` that stands in for the
 * JPA dirty-check flush inside `UserService.suspend`/`reactivate`. None of that
 * is observable from `user.service.test.ts`, which mocks this whole module out
 * — so it is checked here, against the local Postgres that `docker compose up
 * db` starts and Flyway migrates (`MIGRATION_PLAN.md` §8), exactly as
 * `mission.queries.test.ts` does for the mission DAO.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * ## Determinism against a shared table
 * `users` has no per-row tag column to filter on the way `mission` has
 * `description`, and `search(null, …)` is by definition unscoped: it returns
 * every account in the database, including whatever a concurrently running
 * live suite has just registered. The fixtures therefore pin their `created_at`
 * into the far future (year 2999, one distinct second apart), which under the
 * query's `created_at DESC` puts them — and only them — at the head of every
 * listing. That is what lets the ordering and paging cases below assert on
 * *absolute* page contents rather than on relative order. No other suite in
 * this repository writes a far-future `created_at`; that convention is the
 * whole guarantee, so keep it that way.
 *
 * That trick scopes the *content* of a page, and nothing else. `totalElements`
 * comes from `search`'s separate `count` query, which has no `created_at` to
 * hide behind: it counts every matching row in the database, including the ones
 * the suites running in parallel with this one insert — and later delete in
 * their own `afterAll`. So a total is never asserted *equal* to another total
 * read by a different call (that comparison is a race in both directions, and
 * was one: it produced an intermittent red run). Totals are asserted only as
 * floors — "at least this suite's own fixtures" — which is enough to pin the
 * rule that actually matters here: the count is the whole filtered table, not
 * the page slice.
 *
 * There is no Spring counterpart to mirror: the backend has no repository-level
 * integration test (`UserServiceTest` mocks `UserRepository`). Each case names
 * the source rule it pins instead.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../data/repository/UserRepository.java (`search`, `findByEmail`, `existsByEmail`)
 * - drone-missions-backend/.../business/service/user/UserService.java (`findById`, the `repository.save` in `suspend`/`reactivate`)
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("user.queries.ts (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();

  const insertedUserIds: number[] = [];

  /**
   * The fixtures, newest-created first — the order `search` must produce.
   * Filled by `beforeAll` in reverse insertion order.
   */
  let newestFirst: number[] = [];
  let designerA: number;
  let designerB: number;
  let pilotA: number;
  let pilotB: number;
  let adminA: number;

  /**
   * Inserts one account with a pinned `created_at`, so the ordering and paging
   * cases have known, distinct, far-future timestamps to assert on (see the
   * suite header). `offsetSeconds` counts *up* into the future, so a higher
   * offset is a newer account.
   */
  async function insertUser(
    label: string,
    role: UserRole,
    offsetSeconds: number,
    suspended = false,
  ): Promise<number> {
    const createdAt = new Date(Date.UTC(2999, 0, 1, 0, 0, offsetSeconds));
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `user-queries-${label}`,
        email: `user-queries-${runId}-${label}@example.com`,
        // A literal, obviously-not-a-hash placeholder: nothing in this suite
        // authenticates, and the column is only NOT NULL.
        passwordHash: "not-a-real-hash",
        role,
        suspended,
        createdAt,
        updatedAt: createdAt,
      })
      .returning({ id: users.id });
    insertedUserIds.push(row.id);
    return row.id;
  }

  /** The ids of a page, in the order the query returned them. */
  function idsOf(page: { content: { id: number }[] }): number[] {
    return page.content.map((user) => user.id);
  }

  beforeAll(async () => {
    // Inserted oldest-first, so `newestFirst` below is the reverse.
    designerA = await insertUser("designer-a", "DESIGNER", 1);
    pilotA = await insertUser("pilot-a", "PILOT", 2);
    designerB = await insertUser("designer-b", "DESIGNER", 3);
    pilotB = await insertUser("pilot-b", "PILOT", 4, true);
    adminA = await insertUser("admin-a", "ADMIN", 5);
    newestFirst = [adminA, pilotB, designerB, pilotA, designerA];
  });

  afterAll(async () => {
    if (insertedUserIds.length > 0) {
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  describe("search", () => {
    it("returns every account when the role filter is null, newest-created first", async () => {
      // `:role is null or u.role = :role` with a null role — the "everyone"
      // convention the whole admin read path shares.
      const page = await queries.search(null, { page: 0, size: 5 });

      expect(idsOf(page)).toEqual(newestFirst);
      // The count is the *whole* table, not the slice: it is what makes
      // `totalPages` meaningful in the envelope.
      expect(page.totalElements).toBeGreaterThanOrEqual(insertedUserIds.length);
      expect(page.request).toEqual({ page: 0, size: 5 });
    });

    it("narrows to one role and counts only that role", async () => {
      const pilots = await queries.search("PILOT", { page: 0, size: 2 });
      expect(idsOf(pilots)).toEqual([pilotB, pilotA]);

      const designers = await queries.search("DESIGNER", { page: 0, size: 2 });
      expect(idsOf(designers)).toEqual([designerB, designerA]);

      // The count query carries the same filter, so the two totals differ.
      const everyone = await queries.search(null, { page: 0, size: 1 });
      expect(pilots.totalElements).toBeLessThan(everyone.totalElements);
      expect(designers.totalElements).toBeLessThan(everyone.totalElements);

      const admins = await queries.search("ADMIN", { page: 0, size: 5 });
      expect(idsOf(admins)).toContain(adminA);
      expect(admins.content.every((user) => user.role === "ADMIN")).toBe(true);
    });

    it("slices consecutive pages without repeating or dropping a row", async () => {
      const first = await queries.search(null, { page: 0, size: 2 });
      const second = await queries.search(null, { page: 1, size: 2 });
      const third = await queries.search(null, { page: 2, size: 2 });

      expect(idsOf(first)).toEqual(newestFirst.slice(0, 2));
      expect(idsOf(second)).toEqual(newestFirst.slice(2, 4));
      expect(idsOf(third)[0]).toBe(newestFirst[4]);
      // Every page reports a slice-independent total: the count is of the whole
      // table, never of the two rows the page happens to carry. Asserted as a
      // floor rather than as equality across the three calls — see the suite
      // header on why an unscoped `count` cannot be compared to itself here.
      for (const page of [first, second, third]) {
        expect(page.content.length).toBeLessThanOrEqual(2);
        expect(page.totalElements).toBeGreaterThanOrEqual(insertedUserIds.length);
      }
    });

    it("answers an empty page past the end rather than an error", async () => {
      const total = (await queries.search("ADMIN", { page: 0, size: 1 })).totalElements;

      // Far enough past the last page that a concurrently registered admin or
      // two cannot pull the offset back inside the result set.
      const past = await queries.search("ADMIN", { page: total + 1_000, size: 1 });

      expect(past.content).toEqual([]);
      // An out-of-range page still reports the real total — that is what keeps
      // `totalPages` meaningful in the envelope — rather than collapsing to the
      // zero rows it returned. Not re-asserted equal to `total`: this count is
      // unscoped over every ADMIN row (suite header), and `adminA` alone is the
      // floor this suite owns.
      expect(past.totalElements).toBeGreaterThanOrEqual(1);
      expect(past.request).toEqual({ page: total + 1_000, size: 1 });
    });

    it("carries the suspension flag and the full row, hash included, to the mapper", async () => {
      // The query layer selects the whole row on purpose: `toUserResponse`
      // whitelists what leaves the process, and the *service* needs
      // `suspended` and `role` to make its decisions. What must never happen
      // is the password hash reaching a response — that is the mapper's job,
      // pinned in `user.mapper.test.ts`.
      const page = await queries.search("PILOT", { page: 0, size: 2 });
      const suspendedRow = page.content.find((user) => user.id === pilotB);

      expect(suspendedRow?.suspended).toBe(true);
      expect(suspendedRow?.passwordHash).toBe("not-a-real-hash");
      expect(page.content.find((user) => user.id === pilotA)?.suspended).toBe(false);
    });
  });

  describe("setSuspended", () => {
    it("flips the flag, restamps updated_at, and leaves created_at alone", async () => {
      const before = await queries.findById(designerA);

      const suspended = await queries.setSuspended(designerA, true);

      expect(suspended.suspended).toBe(true);
      expect(suspended.createdAt.getTime()).toBe(before.createdAt.getTime());
      // `@UpdateTimestamp` restamps `updated_at` on the JPA flush; the targeted
      // UPDATE does it explicitly (see `user.queries.ts`). "Restamped to now",
      // not "moved forward": these fixtures carry a *far-future* `updated_at`
      // (see the suite header), so a write that stamps the wall clock moves it
      // backwards — which is exactly what a restamp is.
      const wroteAt = suspended.updatedAt.getTime();
      expect(wroteAt).not.toBe(before.updatedAt.getTime());
      expect(Math.abs(wroteAt - Date.now())).toBeLessThan(60_000);
      // The returned row is the live one, not an optimistic in-memory copy.
      const [row] = await getDb().select().from(users).where(eq(users.id, designerA));
      expect(row.suspended).toBe(true);
      expect(row.username).toBe(before.username);
      expect(row.role).toBe("DESIGNER");

      const reactivated = await queries.setSuspended(designerA, false);
      expect(reactivated.suspended).toBe(false);
      expect(
        (await getDb().select().from(users).where(eq(users.id, designerA)))[0].suspended,
      ).toBe(false);
    });

    it("touches no other account", async () => {
      await queries.setSuspended(pilotA, true);

      expect((await queries.findById(designerB)).suspended).toBe(false);
      expect((await queries.findById(pilotB)).suspended).toBe(true);

      await queries.setSuspended(pilotA, false);
    });

    it("throws rather than silently reporting a suspension that never happened", async () => {
      // The unreachable branch `user.queries.ts` documents: nothing in the app
      // deletes a user, so this can only happen if the row vanished between the
      // lookup and the write — and then the caller must not be told it worked.
      await expect(queries.setSuspended(-1, true)).rejects.toBeInstanceOf(UserNotFoundError);
    });
  });

  describe("the id and email lookups", () => {
    it("distinguishes 'no such account' from an error, in both shapes", async () => {
      // `UserService.findById`'s `orElseThrow`...
      await expect(queries.findById(-1)).rejects.toBeInstanceOf(UserNotFoundError);
      await expect(queries.findById(-1)).rejects.toThrow("User -1 not found");
      // ...beside the plain `Optional` the callers that treat an absent account
      // as "nothing to do" use (`BidService.notifyDecision`).
      expect(await queries.findByIdOrUndefined(-1)).toBeUndefined();
      expect((await queries.findByIdOrUndefined(adminA))?.role).toBe("ADMIN");
    });

    it("finds an account by its email and reports existence off the same row", async () => {
      const email = `user-queries-${runId}-admin-a@example.com`;

      expect((await queries.findByEmail(email))?.id).toBe(adminA);
      expect(await queries.existsByEmail(email)).toBe(true);
      expect(await queries.existsByEmail(`nobody-${runId}@example.com`)).toBe(false);
    });
  });
});

describe.skipIf(hasDb)("user.queries.ts (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
