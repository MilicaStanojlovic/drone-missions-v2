import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import type { AuditAction, AuditActorRole, UserRole } from "@/db/schema";
import { search } from "@/features/audit/audit.queries";
import type { AuditSearchFilters } from "@/features/audit/audit.types";

/**
 * Live-DB suite for the audit read query.
 *
 * `audit.queries.ts` is pure SQL, and two of its rules exist *only* as SQL —
 * which is precisely why the source repository spells both out in a comment and
 * why neither can be proven above the database:
 *
 * - the text filter is **two LIKEs OR'd together, never a concat**, because
 *   `details` is nullable and `username || details` is NULL for every row
 *   without details, which would silently hide exactly the rows an admin
 *   searching for a person is looking for;
 * - the pattern is lowercased **in the service, not in the query**, because
 *   `lower(:param)` cannot be typed by PostgreSQL when the parameter is null —
 *   here the predicate is simply not added, so a null filter never reaches the
 *   database at all.
 *
 * Beside those: the actor join that resolves `actorUsername`, the snapshotted
 * `actor_role` filter (which must follow the row, not the account), the
 * `created_at DESC, id DESC` order — audit rows are the likeliest of all to
 * share a timestamp — and the separate count that carries the same filters and
 * the same join.
 *
 * `audit.service.test.ts` mocks this module out entirely, so none of the above
 * is visible from there. Checked here against the local Postgres that
 * `docker compose up db` starts and Flyway migrates (`MIGRATION_PLAN.md` §8),
 * the same shape `mission.queries.test.ts` uses.
 *
 * Every case is scoped to this run's own rows — by `actorId`, or by a `q`
 * pattern containing the run id — so the suite is deterministic against a
 * database that already holds audit history (including a concurrently running
 * route suite writing rows of its own).
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * There is no Spring counterpart to mirror: the backend has no repository-level
 * integration test (`AuditServiceTest` mocks `AuditLogRepository`). Each case
 * names the source rule it pins instead.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../data/repository/AuditLogRepository.java
 * - drone-missions-backend/.../business/service/audit/AuditService.java (`search`, which builds the pattern)
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/** No filter at all — the "everything" baseline every case narrows from. */
const NO_FILTERS: AuditSearchFilters = {
  actorId: null,
  action: null,
  actorRole: null,
  pattern: null,
};

describe.runIf(hasDb)("audit.queries.ts (live DB)", () => {
  /**
   * Unique per run *and* lowercase, because it is matched through
   * `lower(col) LIKE pattern`: the pattern arrives already lowercased from the
   * service, so a run id with uppercase in it could never match itself.
   */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();

  const insertedUserIds: number[] = [];

  let adminId: number;
  let designerId: number;
  /** An account whose *current* role differs from the role its rows snapshot. */
  let promotedId: number;

  async function insertUser(label: string, role: UserRole): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        // The run id lives in the username so a `q` search can find the actor
        // — the half of the OR that a concat would break.
        username: `audit-${label}-${runId}`,
        email: `audit-queries-${runId}-${label}@example.com`,
        // A literal, obviously-not-a-hash placeholder: nothing here
        // authenticates, and the column is only NOT NULL.
        passwordHash: "not-a-real-hash",
        role,
        suspended: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id });
    insertedUserIds.push(row.id);
    return row.id;
  }

  /**
   * Inserts one audit row directly rather than through `record()`, so
   * `created_at` can be pinned: the ordering case needs two rows sharing a
   * timestamp to the microsecond, which a wall-clock stamp cannot guarantee.
   */
  async function insertEntry(values: {
    actorId: number;
    actorRole: AuditActorRole;
    action: AuditAction;
    targetId: number;
    details: string | null;
    createdAt: Date;
  }): Promise<number> {
    const [row] = await getDb()
      .insert(auditLog)
      .values({ ...values, targetType: "MISSION" })
      .returning({ id: auditLog.id });
    return row.id;
  }

  /** The ids of a page, in the order the query returned them. */
  function idsOf(page: { content: { id: number }[] }): number[] {
    return page.content.map((entry) => entry.id);
  }

  /** A whole page of one filter combination — 50 rows is far more than any case seeds. */
  function find(filters: Partial<AuditSearchFilters>) {
    return search({ ...NO_FILTERS, ...filters }, { page: 0, size: 50 });
  }

  const base = new Date(Date.UTC(2999, 0, 1, 12, 0, 0));
  /** `base` plus a whole number of seconds — distinct, ordered timestamps. */
  function at(seconds: number): Date {
    return new Date(base.getTime() + seconds * 1000);
  }

  let hiddenById: number;
  let removedById: number;
  let designerCreatedId: number;
  /** Details-free, so only the actor's username can match it. */
  let namelessId: number;
  /** Snapshotted as PILOT although the account is now a DESIGNER. */
  let snapshotId: number;
  /** Shares `at(4)` with `tieLaterId` — the id tiebreaker's whole point. */
  let tieEarlierId: number;
  let tieLaterId: number;

  beforeAll(async () => {
    adminId = await insertUser("admin", "ADMIN");
    designerId = await insertUser("designer", "DESIGNER");
    promotedId = await insertUser("promoted", "DESIGNER");

    designerCreatedId = await insertEntry({
      actorId: designerId,
      actorRole: "DESIGNER",
      action: "MISSION_CREATED",
      targetId: 1,
      // Mixed case on purpose: the query lowercases the column, so a lowercase
      // pattern still has to find it.
      details: `"Bridge Survey ${runId}"`,
      createdAt: at(1),
    });
    hiddenById = await insertEntry({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "MISSION_HIDDEN",
      targetId: 1,
      details: `"Bridge Survey ${runId}"`,
      createdAt: at(2),
    });
    removedById = await insertEntry({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "MISSION_REMOVED",
      targetId: 2,
      details: `"Ferry inspection ${runId}"`,
      createdAt: at(3),
    });
    namelessId = await insertEntry({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "MISSION_UNHIDDEN",
      targetId: 3,
      details: null,
      createdAt: at(5),
    });
    snapshotId = await insertEntry({
      actorId: promotedId,
      actorRole: "PILOT",
      action: "MISSION_STARTED",
      targetId: 4,
      details: `"Snapshot ${runId}"`,
      createdAt: at(6),
    });
    tieEarlierId = await insertEntry({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "MISSION_HIDDEN",
      targetId: 5,
      details: `"Tied one ${runId}"`,
      createdAt: at(4),
    });
    tieLaterId = await insertEntry({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "MISSION_UNHIDDEN",
      targetId: 5,
      details: `"Tied two ${runId}"`,
      createdAt: at(4),
    });
  });

  afterAll(async () => {
    if (insertedUserIds.length > 0) {
      // Audit rows deliberately outlive their actor (see `audit_log`'s doc
      // comment in db/schema.ts), so they go first and explicitly — the FK has
      // no cascade precisely so history cannot be erased through a user row.
      await getDb().delete(auditLog).where(inArray(auditLog.actorId, insertedUserIds));
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  describe("the four filters", () => {
    it("narrows to one actor and resolves that actor's username through the join", async () => {
      const page = await find({ actorId: designerId });

      expect(idsOf(page)).toEqual([designerCreatedId]);
      // The username comes off the join, not off a second per-row query: the
      // source lets Hibernate resolve `a.actor` lazily (N+1); this is the same
      // rows in one query.
      expect(page.content[0].actorUsername).toBe(`audit-designer-${runId}`);
      expect(page.content[0].actorId).toBe(designerId);
      expect(page.totalElements).toBe(1);
    });

    it("narrows to one action", async () => {
      const page = await find({ actorId: adminId, action: "MISSION_REMOVED" });

      expect(idsOf(page)).toEqual([removedById]);
    });

    it("filters on the role the row snapshotted, not the account's current one", async () => {
      // The whole reason `actor_role` is a column rather than a join: the
      // account is a DESIGNER today, but the row records what they were when
      // they acted, and the filter must follow the row.
      expect((await find({ actorId: promotedId })).content[0].actorRole).toBe("PILOT");
      expect(idsOf(await find({ actorId: promotedId, actorRole: "PILOT" }))).toEqual([snapshotId]);
      expect(await find({ actorId: promotedId, actorRole: "DESIGNER" })).toMatchObject({
        content: [],
        totalElements: 0,
      });
    });

    it("combines every filter with AND", async () => {
      expect(
        idsOf(
          await find({
            actorId: adminId,
            action: "MISSION_HIDDEN",
            actorRole: "ADMIN",
            pattern: `%bridge survey ${runId}%`,
          }),
        ),
      ).toEqual([hiddenById]);

      // One mismatching member is enough to empty the result — `and()`, not `or()`.
      expect(
        await find({
          actorId: adminId,
          action: "MISSION_HIDDEN",
          actorRole: "DESIGNER",
          pattern: `%bridge survey ${runId}%`,
        }),
      ).toMatchObject({ content: [], totalElements: 0 });
    });

    it("omits an unsupplied filter from the SQL entirely", async () => {
      // The port of `:x is null or …`: a null filter adds no predicate, so the
      // query the database sees is the one without that clause. Observable as
      // "null really does mean everything" — this run's rows are a subset of a
      // shared table, so the unfiltered listing must be at least as large.
      const everything = await search(NO_FILTERS, { page: 0, size: 50 });
      const mine = await find({ actorId: adminId });

      expect(everything.totalElements).toBeGreaterThanOrEqual(mine.totalElements);
      expect(mine.totalElements).toBe(5);
    });
  });

  describe("the text pattern", () => {
    it("matches the actor's username on a row that has no details at all", async () => {
      // The concat trap, pinned: `username || details` is NULL for this row, so
      // a concat-based match would drop it — and it is the row an admin
      // searching for a person most needs to see.
      const page = await find({ pattern: `%audit-admin-${runId}%` });

      expect(idsOf(page)).toContain(namelessId);
      expect(page.content.find((entry) => entry.id === namelessId)?.details).toBeNull();
      // Every one of this admin's rows, whatever their details.
      expect(page.totalElements).toBe(5);
    });

    it("matches the details of a row whose actor's name does not match", async () => {
      const page = await find({ pattern: `%ferry inspection ${runId}%` });

      expect(idsOf(page)).toEqual([removedById]);
    });

    it("is case-insensitive on both sides of the OR", async () => {
      // `lower(col) LIKE pattern` with the pattern already lowercased by the
      // service — the split the repository comment insists on.
      expect(idsOf(await find({ pattern: `%bridge survey ${runId}%` }))).toEqual([
        hiddenById,
        designerCreatedId,
      ]);
      // The seeded username is lowercase; a mixed-case *column* is what the
      // details assertion above covers, and both go through the same `lower()`.
      expect(idsOf(await find({ pattern: `%audit-designer-${runId}%` }))).toEqual([
        designerCreatedId,
      ]);
    });

    it("treats a wildcard inside the pattern as a wildcard, unescaped", async () => {
      // Deliberate, and the source says so: "like the mission feed's keyword".
      expect(idsOf(await find({ pattern: `%bridge%${runId}%` }))).toEqual([
        hiddenById,
        designerCreatedId,
      ]);
      // A literal `%` in the text is therefore not findable as a literal — the
      // same trade the source makes.
      expect(await find({ pattern: `%no-such-text-${runId}%` })).toMatchObject({
        content: [],
        totalElements: 0,
      });
    });
  });

  describe("ordering and paging", () => {
    it("returns newest first, breaking a shared timestamp by id", async () => {
      const page = await find({ actorId: adminId });

      // `at(5)`, `at(4)`+`at(4)`, `at(3)`, `at(2)` — and the two rows sharing
      // `at(4)` come back newest-inserted first. Without the `id DESC`
      // tiebreaker their order would be unspecified, which under paging can put
      // one row on two pages or on none; several audit rows are written inside
      // a single request, so ties are the norm here rather than the exception.
      expect(idsOf(page)).toEqual([namelessId, tieLaterId, tieEarlierId, removedById, hiddenById]);
    });

    it("slices consecutive pages without repeating or dropping a row, and counts the whole match", async () => {
      const filters = { ...NO_FILTERS, actorId: adminId };
      const first = await search(filters, { page: 0, size: 2 });
      const second = await search(filters, { page: 1, size: 2 });
      const third = await search(filters, { page: 2, size: 2 });

      expect(idsOf(first)).toEqual([namelessId, tieLaterId]);
      expect(idsOf(second)).toEqual([tieEarlierId, removedById]);
      expect(idsOf(third)).toEqual([hiddenById]);
      // The count ignores the slice — that is what makes `totalPages` in the
      // envelope meaningful — and is the same on every page.
      expect([first, second, third].map((page) => page.totalElements)).toEqual([5, 5, 5]);
      expect(first.request).toEqual({ page: 0, size: 2 });
    });

    it("counts through the same join the listing uses, so a username match is counted as it is listed", async () => {
      const page = await search({ ...NO_FILTERS, pattern: `%audit-admin-${runId}%` }, {
        page: 0,
        size: 2,
      });

      expect(page.content).toHaveLength(2);
      // Five rows match through the joined username; a count that dropped the
      // join would find none of them.
      expect(page.totalElements).toBe(5);
    });

    it("answers an empty page past the end rather than an error", async () => {
      const page = await search({ ...NO_FILTERS, actorId: adminId }, { page: 9, size: 5 });

      expect(page.content).toEqual([]);
      expect(page.totalElements).toBe(5);
    });
  });
});

describe.skipIf(hasDb)("audit.queries.ts (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
