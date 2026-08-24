import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { mission, notification, users } from "@/db/schema";
import { insertUser } from "@/features/users/server/user.queries";
import {
  NotificationNotFoundError,
  create,
  listFor,
  markAllRead,
  markRead,
  overdueExists,
  unreadCount,
} from "@/features/notifications/server/notification.service";
import { NewNotification, type NotificationType } from "@/features/notifications/notification.types";

/**
 * Live-DB suite for `notification.service.ts` (and, through it,
 * `notification.queries.ts`).
 *
 * There is no `NotificationServiceTest` in the source repo — the Spring side
 * ships no JUnit coverage for this service at all — so these cases are
 * written against the semantics read directly off
 * `NotificationService.java` / `NotificationRepository.java`, one case per
 * behavior the port has to preserve:
 *
 * - `findByUser_IdOrderByCreatedAtDesc` — newest first, scoped to one user;
 * - `countByUser_IdAndReadAtIsNull` — the bell badge's number;
 * - `markRead`'s `findByIdAndUser_Id(...).orElseThrow(...)` — another user's
 *   id is indistinguishable from a missing one (masked 404), and its
 *   `if (getReadAt() == null)` guard makes a second call a no-op;
 * - `markAllRead`'s filter-then-save loop — unread rows only, one shared
 *   `Instant now`, already-read rows keep their earlier `readAt`;
 * - `existsByUser_IdAndMission_IdAndType` — the overdue-sweep dedupe, which
 *   has to match on all three columns.
 *
 * Live-DB only, following `tests/lib/audit.test.ts` and the auth/users route
 * suites: runs against the Postgres named by `DATABASE_URL` (this worktree's
 * `dronemissions_p4`, per `.env.local`), and skips with a visible reason when
 * none is configured. `vitest.config.ts` forwards the variable from
 * `.env.local`/`.env`.
 *
 * Per the phase plan there is no missions feature module yet, so the mission
 * rows these notifications point at are inserted straight through Drizzle
 * against `mission` in `src/db/schema.ts` — never via a `features/missions`
 * import.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/notification/NotificationService.java
 * - drone-missions-backend/.../data/repository/NotificationRepository.java
 * - drone-missions-backend/.../business/exception/notification/NotificationNotFoundException.java
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("notification.service.ts (live DB)", () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;

  const createdUserIds: number[] = [];
  const createdMissionIds: number[] = [];

  /**
   * A fresh account per call (unique email, so reruns against the same
   * database never collide with `users_email_unique`). Every test that counts
   * or lists rows takes its own user, which is what keeps the assertions
   * independent of anything other tests — or an earlier run — left behind.
   */
  async function newUser(role: "PILOT" | "DESIGNER" = "PILOT"): Promise<number> {
    seq += 1;
    const user = await insertUser({
      username: `notif-svc-user-${seq}`,
      email: `notif-svc-${runId}-${seq}@example.com`,
      passwordHash: "not-a-real-hash",
      role,
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  /**
   * A minimal `mission` row, inserted directly — only the NOT NULL columns
   * (`status`, `created_at`, `updated_at`) plus the two fields a notification
   * actually reads back (`id`, `name`).
   */
  async function newMission(name: string, designerId: number) {
    const now = new Date();
    const [row] = await getDb()
      .insert(mission)
      .values({
        name,
        status: "AWARDED",
        userId: designerId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    createdMissionIds.push(row.id);
    return { id: row.id, name: row.name ?? name };
  }

  /**
   * Inserts a notification with an explicitly chosen `createdAt`/`readAt`,
   * bypassing the service's own "stamp `now`" behavior — the only way to set
   * up rows whose creation order differs from their id order, or which are
   * already read.
   */
  async function seedNotification(values: {
    userId: number;
    type: NotificationType;
    title: string;
    message: string;
    missionId?: number | null;
    createdAt: Date;
    readAt?: Date | null;
  }) {
    const [row] = await getDb()
      .insert(notification)
      .values({
        userId: values.userId,
        type: values.type,
        title: values.title,
        message: values.message,
        missionId: values.missionId ?? null,
        readAt: values.readAt ?? null,
        createdAt: values.createdAt,
        updatedAt: values.createdAt,
      })
      .returning();
    return row;
  }

  async function readAtOf(id: number): Promise<Date | null> {
    const [row] = await getDb().select().from(notification).where(eq(notification.id, id));
    return row.readAt;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      // Notification rows cascade from both `users` and `mission`, but are
      // deleted explicitly first so the cleanup doesn't depend on that.
      await getDb().delete(notification).where(inArray(notification.userId, createdUserIds));
    }
    if (createdMissionIds.length > 0) {
      // `fk_mission_user` has no ON DELETE action, so missions must go before
      // the designers that own them.
      await getDb().delete(mission).where(inArray(mission.id, createdMissionIds));
    }
    if (createdUserIds.length > 0) {
      await getDb().delete(users).where(inArray(users.id, createdUserIds));
    }
    await closeDb();
  });

  describe("create", () => {
    it("persists a factory-built notification unread, with the mission flattened to its id", async () => {
      const designerId = await newUser("DESIGNER");
      const pilotId = await newUser();
      const target = await newMission("Rooftop survey", designerId);

      const row = await create(NewNotification.bidAccepted(pilotId, target));

      expect(row.id).toBeGreaterThan(0);
      expect(row.userId).toBe(pilotId);
      expect(row.type).toBe("BID_ACCEPTED");
      expect(row.title).toBe("Bid accepted");
      expect(row.message).toBe('Your bid on "Rooftop survey" was accepted — the mission is yours.');
      expect(row.missionId).toBe(target.id);
      // `NotificationService.create` never sets `readAt`: a new notification
      // is unread by definition.
      expect(row.readAt).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);

      const [fromDb] = await getDb().select().from(notification).where(eq(notification.id, row.id));
      expect(fromDb).toMatchObject({ userId: pilotId, type: "BID_ACCEPTED", missionId: target.id });
    });

    it("stores a null mission_id when the notification is not about a mission", async () => {
      const pilotId = await newUser();

      const row = await create({
        userId: pilotId,
        type: "MISSION_CANCELLED",
        title: "Mission cancelled",
        message: "A mission was cancelled.",
        mission: null,
      });

      expect(row.missionId).toBeNull();
    });
  });

  describe("listFor", () => {
    it("returns the caller's notifications newest first, by created_at rather than by id", async () => {
      const pilotId = await newUser();
      const base = Date.now();

      // Deliberately inserted oldest-id-first but *not* oldest-created-first:
      // if the ordering ever fell back to insertion order, `middle` would come
      // out ahead of `newest`.
      const oldest = await seedNotification({
        userId: pilotId,
        type: "BID_REJECTED",
        title: "Bid not selected",
        message: "oldest",
        createdAt: new Date(base - 30_000),
      });
      const newest = await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "newest",
        createdAt: new Date(base),
      });
      const middle = await seedNotification({
        userId: pilotId,
        type: "MISSION_OVERDUE",
        title: "Has your flight ended?",
        message: "middle",
        createdAt: new Date(base - 15_000),
      });

      const list = await listFor(pilotId);

      expect(list.map((n) => n.id)).toEqual([newest.id, middle.id, oldest.id]);
    });

    it("is scoped to the caller — another user's notifications never leak in", async () => {
      const pilotId = await newUser();
      const otherPilotId = await newUser();
      const now = new Date();

      const mine = await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "mine",
        createdAt: now,
      });
      await seedNotification({
        userId: otherPilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "theirs",
        createdAt: now,
      });

      const list = await listFor(pilotId);

      expect(list.map((n) => n.id)).toEqual([mine.id]);
    });

    it("returns an empty list for a user with no notifications", async () => {
      const pilotId = await newUser();
      await expect(listFor(pilotId)).resolves.toEqual([]);
    });
  });

  describe("unreadCount", () => {
    it("counts only the caller's unread notifications", async () => {
      const pilotId = await newUser();
      const otherPilotId = await newUser();
      const now = new Date();

      await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "unread 1",
        createdAt: now,
      });
      await seedNotification({
        userId: pilotId,
        type: "BID_REJECTED",
        title: "Bid not selected",
        message: "unread 2",
        createdAt: now,
      });
      await seedNotification({
        userId: pilotId,
        type: "MISSION_OVERDUE",
        title: "Has your flight ended?",
        message: "already read",
        createdAt: now,
        readAt: now,
      });
      await seedNotification({
        userId: otherPilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "someone else's unread",
        createdAt: now,
      });

      await expect(unreadCount(pilotId)).resolves.toBe(2);
    });

    it("is 0 for a user with no notifications", async () => {
      const pilotId = await newUser();
      await expect(unreadCount(pilotId)).resolves.toBe(0);
    });

    it("drops by one after that notification is marked read", async () => {
      const pilotId = await newUser();
      const now = new Date();
      const first = await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "one",
        createdAt: now,
      });
      await seedNotification({
        userId: pilotId,
        type: "BID_REJECTED",
        title: "Bid not selected",
        message: "two",
        createdAt: now,
      });
      await expect(unreadCount(pilotId)).resolves.toBe(2);

      await markRead(first.id, pilotId);

      await expect(unreadCount(pilotId)).resolves.toBe(1);
    });
  });

  describe("markRead", () => {
    it("stamps read_at on an unread notification", async () => {
      const pilotId = await newUser();
      const row = await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "unread",
        createdAt: new Date(),
      });
      expect(row.readAt).toBeNull();

      await markRead(row.id, pilotId);

      expect(await readAtOf(row.id)).toBeInstanceOf(Date);
    });

    it("is idempotent — a second call leaves the original read_at untouched", async () => {
      const pilotId = await newUser();
      const row = await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "unread",
        createdAt: new Date(),
      });

      await markRead(row.id, pilotId);
      const firstReadAt = await readAtOf(row.id);
      await sleep(10);
      await markRead(row.id, pilotId);

      // The source's `if (getReadAt() == null)` guard means the second call
      // never re-saves; a re-stamp would show up as a later timestamp here.
      expect((await readAtOf(row.id))?.getTime()).toBe(firstReadAt?.getTime());
      await expect(unreadCount(pilotId)).resolves.toBe(0);
    });

    it("throws NotificationNotFoundError for another user's notification, without touching it", async () => {
      const ownerId = await newUser();
      const intruderId = await newUser();
      const row = await seedNotification({
        userId: ownerId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "not yours",
        createdAt: new Date(),
      });

      // Masked as not-found rather than forbidden: `findByIdAndUser_Id`
      // returns an empty Optional for both cases, so the id can't be probed.
      await expect(markRead(row.id, intruderId)).rejects.toBeInstanceOf(NotificationNotFoundError);
      await expect(markRead(row.id, intruderId)).rejects.toMatchObject({
        status: 404,
        message: `Notification ${row.id} not found`,
      });
      expect(await readAtOf(row.id)).toBeNull();
      await expect(unreadCount(ownerId)).resolves.toBe(1);
    });

    it("throws the same NotificationNotFoundError for an id that does not exist", async () => {
      const pilotId = await newUser();
      const missingId = 999_999_999;

      await expect(markRead(missingId, pilotId)).rejects.toBeInstanceOf(NotificationNotFoundError);
      await expect(markRead(missingId, pilotId)).rejects.toMatchObject({
        status: 404,
        message: `Notification ${missingId} not found`,
      });
    });
  });

  describe("markAllRead", () => {
    it("marks only unread rows, at one shared instant, preserving an earlier read_at", async () => {
      const pilotId = await newUser();
      const now = new Date();
      const alreadyRead = await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "already read",
        createdAt: now,
      });
      const unreadA = await seedNotification({
        userId: pilotId,
        type: "BID_REJECTED",
        title: "Bid not selected",
        message: "unread A",
        createdAt: now,
      });
      const unreadB = await seedNotification({
        userId: pilotId,
        type: "MISSION_OVERDUE",
        title: "Has your flight ended?",
        message: "unread B",
        createdAt: now,
      });

      await markRead(alreadyRead.id, pilotId);
      const earlierReadAt = await readAtOf(alreadyRead.id);
      await sleep(10);

      await markAllRead(pilotId);

      await expect(unreadCount(pilotId)).resolves.toBe(0);
      // Untouched: the source's `.filter(n -> n.getReadAt() == null)` skips it.
      expect((await readAtOf(alreadyRead.id))?.getTime()).toBe(earlierReadAt?.getTime());
      const readA = await readAtOf(unreadA.id);
      const readB = await readAtOf(unreadB.id);
      expect(readA).toBeInstanceOf(Date);
      // One hoisted `Instant now` for the whole sweep, as in the source loop.
      expect(readB?.getTime()).toBe(readA?.getTime());
      expect(readA!.getTime()).toBeGreaterThan(earlierReadAt!.getTime());
    });

    it("leaves another user's unread notifications alone", async () => {
      const pilotId = await newUser();
      const otherPilotId = await newUser();
      const now = new Date();
      await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "mine",
        createdAt: now,
      });
      const theirs = await seedNotification({
        userId: otherPilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "theirs",
        createdAt: now,
      });

      await markAllRead(pilotId);

      await expect(unreadCount(pilotId)).resolves.toBe(0);
      expect(await readAtOf(theirs.id)).toBeNull();
      await expect(unreadCount(otherPilotId)).resolves.toBe(1);
    });

    it("is a no-op — not an error — when there is nothing unread", async () => {
      const pilotId = await newUser();
      await expect(markAllRead(pilotId)).resolves.toBeUndefined();
      await expect(unreadCount(pilotId)).resolves.toBe(0);
    });
  });

  describe("overdueExists", () => {
    it("is true only for the same user + mission + MISSION_OVERDUE triple", async () => {
      const designerId = await newUser("DESIGNER");
      const pilotId = await newUser();
      const otherPilotId = await newUser();
      const overdueMission = await newMission("Overdue survey", designerId);
      const otherMission = await newMission("Other survey", designerId);
      const now = new Date();

      await seedNotification({
        userId: pilotId,
        type: "MISSION_OVERDUE",
        title: "Has your flight ended?",
        message: "overdue",
        missionId: overdueMission.id,
        createdAt: now,
      });
      // Same user, a different mission, and a non-overdue type: the type
      // column has to be part of the match, or this row would wrongly make
      // the overdue sweep skip `otherMission`.
      await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "accepted",
        missionId: otherMission.id,
        createdAt: now,
      });

      await expect(overdueExists(pilotId, overdueMission.id)).resolves.toBe(true);
      await expect(overdueExists(pilotId, otherMission.id)).resolves.toBe(false);
      await expect(overdueExists(otherPilotId, overdueMission.id)).resolves.toBe(false);
    });
  });
});

describe.skipIf(hasDb)("notification.service.ts (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
