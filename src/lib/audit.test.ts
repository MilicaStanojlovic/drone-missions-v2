import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import {
  bidPlaced,
  bidWithdrawn,
  missionCreated,
  missionDeleted,
  missionUpdated,
  record,
  userLoggedIn,
  userRegistered,
  type AuditActorUser,
} from "./audit";

/**
 * Vitest suite for `audit.ts`.
 *
 * Live-DB only: writes a real row against the local Postgres started by
 * `docker compose up db` (see `MIGRATION_PLAN.md` §8), the way the plan
 * task calls for. Skipped — with a visible reason, mirroring
 * `GET /api/health`'s `not_configured` branch — whenever `DATABASE_URL`
 * isn't wired up (e.g. CI before a `DATABASE_URL` secret exists; see
 * `.github/workflows/ci.yml`). `vitest.config.ts` forwards `DATABASE_URL`
 * from `.env.local`/`.env` when present.
 *
 * SOURCE: drone-missions-backend/.../business/service/audit/AuditService.java,
 * .../business/service/audit/NewAuditEntry.java.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/**
 * The entry factories are pure functions, so they need no database — these
 * mirror the mission cases of `NewAuditEntryTest`
 * (`designerFactoriesPairRoleActionAndNameSnapshot`, plus the
 * updated/deleted actions); its `bidFactoriesSnapshotAmountAndMissionName`
 * case is mirrored in the next block. Its remaining cases belong to factories
 * that are still not ported: the pilot/moderation mission ones (Phases 5/7),
 * the rating one (Phase 6), and the admin user ones
 * (Phase 7). `userFactoriesTargetTheUserAndSnapshotTheUsername`'s
 * `userSuspended`/`userReactivated` half is Phase 7 too; the self-actored
 * `selfActionsCarryTheUsersOwnRole` case is covered live below.
 *
 * `actorIdIsMandatory` has no port: the Java record enforces it with
 * `Objects.requireNonNull` because a caller can pass a null `Long`, whereas
 * `NewAuditEntry.actorId` is a non-nullable `number` here and the compiler
 * rejects the call outright.
 *
 * SOURCE: drone-missions-backend/.../business/service/audit/NewAuditEntryTest.java
 */
describe("mission audit factories", () => {
  const mission = { id: 4, name: "Orchard survey" };

  it("designerFactoriesPairRoleActionAndNameSnapshot — missionCreated", () => {
    expect(missionCreated(7, mission)).toEqual({
      actorId: 7,
      actorRole: "DESIGNER",
      action: "MISSION_CREATED",
      targetType: "MISSION",
      targetId: 4,
      details: '"Orchard survey"',
    });
  });

  it("missionUpdated and missionDeleted keep the designer role and target the mission", () => {
    expect(missionUpdated(7, mission)).toMatchObject({
      actorRole: "DESIGNER",
      action: "MISSION_UPDATED",
      targetType: "MISSION",
      targetId: 4,
    });
    expect(missionDeleted(7, mission)).toMatchObject({
      actorRole: "DESIGNER",
      action: "MISSION_DELETED",
      targetId: 4,
      details: '"Orchard survey"',
    });
  });

  it("renders an unnamed mission the way String.formatted(null) does", () => {
    // `mission.name` is a nullable column; Java's `"\"%s\"".formatted(null)`
    // yields the literal `"null"`, and so does this.
    expect(missionCreated(7, { id: 4, name: null }).details).toBe('"null"');
  });
});

/**
 * Mirrors `NewAuditEntryTest.bidFactoriesSnapshotAmountAndMissionName`, minus
 * its final `bidAccepted` assertion — that factory arrives with the accept
 * flow in Phase 5.
 *
 * The Java fixture's `BigDecimal.TEN` becomes the number `10`, and both render
 * `"10"`, so the source's exact `details` expectation ports across unchanged.
 * See `bidPlaced`'s note for where the two renderings *do* part ways (a
 * scale-carrying `BigDecimal` from the `numeric(12, 2)` column).
 *
 * SOURCE: drone-missions-backend/.../business/service/audit/NewAuditEntryTest.java
 */
describe("bid audit factories", () => {
  const bid = { id: 8, amount: 10, mission: { id: 4, name: "Orchard survey" } };

  it("bidFactoriesSnapshotAmountAndMissionName — bidPlaced", () => {
    expect(bidPlaced(5, bid, false)).toEqual({
      actorId: 5,
      actorRole: "PILOT",
      action: "BID_PLACED",
      targetType: "BID",
      targetId: 8,
      details: '10 on "Orchard survey"',
    });
  });

  it("marks an upserted bid with the (updated) suffix", () => {
    expect(bidPlaced(5, bid, true).details).toBe('10 on "Orchard survey" (updated)');
    expect(bidPlaced(5, bid, true).details?.endsWith("(updated)")).toBe(true);
  });

  it("bidWithdrawn keeps the pilot role and the same snapshot, without the suffix", () => {
    expect(bidWithdrawn(5, bid)).toEqual({
      actorId: 5,
      actorRole: "PILOT",
      action: "BID_WITHDRAWN",
      targetType: "BID",
      targetId: 8,
      details: '10 on "Orchard survey"',
    });
  });

  it("renders a decimal amount and an unnamed mission", () => {
    // `quoted(null)` renders the literal `"null"` here exactly as it does for
    // the mission factories; the amount keeps whatever digits the number has.
    expect(bidPlaced(5, { id: 8, amount: 1500.5, mission: { name: null } }, false).details).toBe(
      '1500.5 on "null"',
    );
  });
});

describe.runIf(hasDb)("audit.ts (live DB)", () => {
  // A fresh user per test run (unique email) so reruns against the same
  // database never collide with the `users_email_unique` constraint.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let actor: AuditActorUser;
  const insertedAuditLogIds: number[] = [];

  beforeAll(async () => {
    const [inserted] = await getDb()
      .insert(users)
      .values({
        username: `audit-test-${runId}`,
        email: `audit-test-${runId}@example.com`,
        passwordHash: "not-a-real-hash",
        role: "DESIGNER",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    actor = { id: inserted.id, role: inserted.role, username: inserted.username };
  });

  afterAll(async () => {
    if (insertedAuditLogIds.length > 0) {
      for (const id of insertedAuditLogIds) {
        await getDb().delete(auditLog).where(eq(auditLog.id, id));
      }
    }
    if (actor) {
      await getDb().delete(users).where(eq(users.id, actor.id));
    }
    await closeDb();
  });

  describe("userRegistered", () => {
    it("writes a USER_REGISTERED row with the user as both actor and target", async () => {
      const row = await record(userRegistered(actor));
      insertedAuditLogIds.push(row.id);

      expect(row.id).toBeGreaterThan(0);
      expect(row.actorId).toBe(actor.id);
      expect(row.actorRole).toBe("DESIGNER");
      expect(row.action).toBe("USER_REGISTERED");
      expect(row.targetType).toBe("USER");
      expect(row.targetId).toBe(actor.id);
      expect(row.details).toBe(`"${actor.username}"`);
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it("persists the row so it round-trips back out of the table", async () => {
      const row = await record(userRegistered(actor));
      insertedAuditLogIds.push(row.id);

      const [fromDb] = await getDb().select().from(auditLog).where(eq(auditLog.id, row.id));
      expect(fromDb).toMatchObject({
        actorId: actor.id,
        action: "USER_REGISTERED",
        targetType: "USER",
        targetId: actor.id,
      });
    });
  });

  describe("userLoggedIn", () => {
    it("writes a USER_LOGGED_IN row with the user as both actor and target", async () => {
      const row = await record(userLoggedIn(actor));
      insertedAuditLogIds.push(row.id);

      expect(row.actorId).toBe(actor.id);
      expect(row.actorRole).toBe(actor.role);
      expect(row.action).toBe("USER_LOGGED_IN");
      expect(row.targetType).toBe("USER");
      expect(row.targetId).toBe(actor.id);
      expect(row.details).toBe(`"${actor.username}"`);
    });
  });
});

describe.skipIf(hasDb)("audit.ts (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
