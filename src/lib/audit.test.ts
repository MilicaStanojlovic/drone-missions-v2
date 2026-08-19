import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import {
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
 * updated/deleted actions). Its remaining cases belong to factories this
 * phase has not ported: the pilot/moderation mission ones (Phases 5/7), the
 * bid ones (Phase 3), the rating one (Phase 6), and the admin user ones
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
