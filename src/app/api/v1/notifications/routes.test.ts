import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/db/client";
import { mission, notification, users } from "@/db/schema";
import { middleware } from "@/middleware";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import { insertUser } from "@/features/users/user.queries";
import type { NotificationType, UserRole } from "@/db/schema";
import { GET as listRoute } from "./route";
import { GET as unreadCountRoute } from "./unread-count/route";
import { POST as markReadRoute } from "./[id]/read/route";
import { POST as markAllReadRoute } from "./read-all/route";

/**
 * Route-level integration suite for
 * `/api/v1/notifications{,/unread-count,/{id}/read,/read-all}`.
 *
 * Live-DB only, mirroring `src/app/api/v1/users/me/route.test.ts`: calls the
 * real exported handlers against the Postgres named by `DATABASE_URL` (this
 * worktree's `dronemissions_p4`), and skips with a visible reason when none
 * is configured.
 *
 * All four paths are authenticated-only — none of them are in
 * `src/middleware.ts`'s `PUBLIC_PATHS` — so the anonymous cases are exercised
 * by calling `middleware()` directly, the layer that actually rejects them in
 * the deployed app (the same precedent the auth/users suites set), while the
 * authenticated cases call the handler with the `x-user-id`/`x-user-role`
 * headers `middleware.ts` would have attached from the verified token's
 * `sub`/`role` claims.
 *
 * What is asserted here is the *contract* — status codes and response shape
 * against `NotificationController.java`: a bare `NotificationResponse[]`,
 * the literal `{"count": n}` envelope `Map.of("count", ...)` serializes to,
 * and `ResponseEntity.noContent()`'s body-less 204s. The underlying
 * behavior (ordering, dedupe, idempotence) is covered one layer down in
 * `src/features/notifications/notification.service.test.ts`.
 *
 * Mission rows are inserted straight through Drizzle against `mission` in
 * `src/db/schema.ts` — this phase has no missions feature module to import.
 *
 * SOURCE: drone-missions-backend/.../web/controller/notification/NotificationController.java
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("notification routes (live DB)", () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;

  const createdUserIds: number[] = [];
  const createdMissionIds: number[] = [];

  const ctx = { params: Promise.resolve({}) };

  /** A fresh account per call, so no test's counts depend on another's rows. */
  async function newUser(role: UserRole = "PILOT"): Promise<number> {
    seq += 1;
    const user = await insertUser({
      username: `notif-route-user-${seq}`,
      email: `notif-route-${runId}-${seq}@example.com`,
      passwordHash: "not-a-real-hash",
      role,
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function newMission(name: string, designerId: number): Promise<number> {
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
    return row.id;
  }

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

  /** A request carrying the headers `middleware.ts` attaches once the token verifies. */
  function authed(path: string, userId: number, role: UserRole = "PILOT"): NextRequest {
    return new NextRequest(new URL(`http://localhost${path}`), {
      headers: { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role },
    });
  }

  function readCtx(id: number | string) {
    return { params: Promise.resolve({ id: String(id) }) };
  }

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await getDb().delete(notification).where(inArray(notification.userId, createdUserIds));
    }
    if (createdMissionIds.length > 0) {
      await getDb().delete(mission).where(inArray(mission.id, createdMissionIds));
    }
    if (createdUserIds.length > 0) {
      await getDb().delete(users).where(inArray(users.id, createdUserIds));
    }
    await closeDb();
  });

  describe("GET /api/v1/notifications", () => {
    it("returns the caller's notifications newest first, as a bare NotificationResponse array", async () => {
      const designerId = await newUser("DESIGNER");
      const pilotId = await newUser();
      const missionId = await newMission("Bridge inspection", designerId);
      const base = Date.now();

      const older = await seedNotification({
        userId: pilotId,
        type: "BID_REJECTED",
        title: "Bid not selected",
        message: 'Your bid on "Bridge inspection" wasn\'t selected.',
        createdAt: new Date(base - 60_000),
        readAt: new Date(base - 30_000),
      });
      const newer = await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: 'Your bid on "Bridge inspection" was accepted — the mission is yours.',
        missionId,
        createdAt: new Date(base),
      });

      const response = await listRoute(authed("/api/v1/notifications", pilotId), ctx);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body[0]).toEqual({
        id: newer.id,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: 'Your bid on "Bridge inspection" was accepted — the mission is yours.',
        missionId,
        read: false,
        createdAt: newer.createdAt.toISOString(),
      });
      // The DTO flattens the mission association to a null-safe id and `readAt`
      // to the boolean `read`; the timestamp itself is never exposed.
      expect(body[1]).toMatchObject({ id: older.id, missionId: null, read: true });
      expect(body[1]).not.toHaveProperty("readAt");
      expect(Object.keys(body[0]).sort()).toEqual([
        "createdAt",
        "id",
        "message",
        "missionId",
        "read",
        "title",
        "type",
      ]);
    });

    it("returns an empty array (not 404) when the caller has no notifications", async () => {
      const pilotId = await newUser();

      const response = await listRoute(authed("/api/v1/notifications", pilotId), ctx);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([]);
    });

    it("is scoped to the caller, whatever role they hold", async () => {
      const pilotId = await newUser();
      const designerId = await newUser("DESIGNER");
      await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "a pilot's notification",
        createdAt: new Date(),
      });

      // `@PreAuthorize("isAuthenticated()")`, not `hasRole('PILOT')`: a
      // designer is served too — with their own (here, empty) list.
      const response = await listRoute(
        authed("/api/v1/notifications", designerId, "DESIGNER"),
        ctx,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([]);
    });

    it("rejects an anonymous request with 401 at the middleware layer", async () => {
      const response = await middleware(
        new NextRequest(new URL("http://localhost/api/v1/notifications")),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/v1/notifications/unread-count", () => {
    it("returns the literal {count} envelope", async () => {
      const pilotId = await newUser();
      const now = new Date();
      await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "unread one",
        createdAt: now,
      });
      await seedNotification({
        userId: pilotId,
        type: "BID_REJECTED",
        title: "Bid not selected",
        message: "unread two",
        createdAt: now,
      });
      await seedNotification({
        userId: pilotId,
        type: "MISSION_OVERDUE",
        title: "Has your flight ended?",
        message: "read",
        createdAt: now,
        readAt: now,
      });

      const response = await unreadCountRoute(
        authed("/api/v1/notifications/unread-count", pilotId),
        ctx,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      // The Angular bell reads `.count` off this object, so the envelope has
      // to stay literal — not a bare number, not a wrapper DTO.
      expect(body).toEqual({ count: 2 });
      expect(Object.keys(body)).toEqual(["count"]);
    });

    it("returns {count: 0} for a caller with nothing unread", async () => {
      const pilotId = await newUser();

      const response = await unreadCountRoute(
        authed("/api/v1/notifications/unread-count", pilotId),
        ctx,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ count: 0 });
    });

    it("rejects an anonymous request with 401 at the middleware layer", async () => {
      const response = await middleware(
        new NextRequest(new URL("http://localhost/api/v1/notifications/unread-count")),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("POST /api/v1/notifications/{id}/read", () => {
    it("returns a body-less 204 and drops the unread count", async () => {
      const pilotId = await newUser();
      const row = await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "unread",
        createdAt: new Date(),
      });

      const response = await markReadRoute(
        authed(`/api/v1/notifications/${row.id}/read`, pilotId),
        readCtx(row.id),
      );

      expect(response.status).toBe(204);
      await expect(response.text()).resolves.toBe("");

      const countResponse = await unreadCountRoute(
        authed("/api/v1/notifications/unread-count", pilotId),
        ctx,
      );
      await expect(countResponse.json()).resolves.toEqual({ count: 0 });
    });

    it("is idempotent — re-marking an already-read notification is another 204", async () => {
      const pilotId = await newUser();
      const row = await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "unread",
        createdAt: new Date(),
      });

      const first = await markReadRoute(
        authed(`/api/v1/notifications/${row.id}/read`, pilotId),
        readCtx(row.id),
      );
      const second = await markReadRoute(
        authed(`/api/v1/notifications/${row.id}/read`, pilotId),
        readCtx(row.id),
      );

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
    });

    it("masks another user's notification as 404, with the same body a missing id gives", async () => {
      const ownerId = await newUser();
      const intruderId = await newUser();
      const row = await seedNotification({
        userId: ownerId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "not yours",
        createdAt: new Date(),
      });

      const response = await markReadRoute(
        authed(`/api/v1/notifications/${row.id}/read`, intruderId),
        readCtx(row.id),
      );
      const body = await response.json();

      // 404, never 403: a 403 would confirm the id exists.
      expect(response.status).toBe(404);
      expect(body).toEqual({
        data: null,
        status: "NOT_FOUND",
        message: `Notification ${row.id} not found`,
      });

      // ...and the row really is untouched.
      const [fromDb] = await getDb().select().from(notification).where(eq(notification.id, row.id));
      expect(fromDb.readAt).toBeNull();
    });

    it("returns 404 for an id that does not exist", async () => {
      const pilotId = await newUser();
      const missingId = 999_999_999;

      const response = await markReadRoute(
        authed(`/api/v1/notifications/${missingId}/read`, pilotId),
        readCtx(missingId),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        data: null,
        status: "NOT_FOUND",
        message: `Notification ${missingId} not found`,
      });
    });

    it("returns 400 for a non-numeric id, the way Spring's Long converter would", async () => {
      const pilotId = await newUser();

      const response = await markReadRoute(
        authed("/api/v1/notifications/not-a-number/read", pilotId),
        readCtx("not-a-number"),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.status).toBe("BAD_REQUEST");
      expect(body.data).toMatchObject({ id: "Invalid value for parameter 'id'" });
    });

    it("rejects an anonymous request with 401 at the middleware layer", async () => {
      const response = await middleware(
        new NextRequest(new URL("http://localhost/api/v1/notifications/1/read"), {
          method: "POST",
        }),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("POST /api/v1/notifications/read-all", () => {
    it("returns a body-less 204 and zeroes the caller's unread count", async () => {
      const pilotId = await newUser();
      const now = new Date();
      await seedNotification({
        userId: pilotId,
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: "unread one",
        createdAt: now,
      });
      await seedNotification({
        userId: pilotId,
        type: "BID_REJECTED",
        title: "Bid not selected",
        message: "unread two",
        createdAt: now,
      });

      const response = await markAllReadRoute(
        authed("/api/v1/notifications/read-all", pilotId),
        ctx,
      );

      expect(response.status).toBe(204);
      await expect(response.text()).resolves.toBe("");

      const countResponse = await unreadCountRoute(
        authed("/api/v1/notifications/unread-count", pilotId),
        ctx,
      );
      await expect(countResponse.json()).resolves.toEqual({ count: 0 });

      // The list still comes back — every row simply reads as `read: true`.
      const listResponse = await listRoute(authed("/api/v1/notifications", pilotId), ctx);
      const list = await listResponse.json();
      expect(list).toHaveLength(2);
      expect(list.every((n: { read: boolean }) => n.read)).toBe(true);
    });

    it("is still a 204 when there is nothing unread to mark", async () => {
      const pilotId = await newUser();

      const response = await markAllReadRoute(
        authed("/api/v1/notifications/read-all", pilotId),
        ctx,
      );

      expect(response.status).toBe(204);
    });

    it("rejects an anonymous request with 401 at the middleware layer", async () => {
      const response = await middleware(
        new NextRequest(new URL("http://localhost/api/v1/notifications/read-all"), {
          method: "POST",
        }),
      );
      expect(response.status).toBe(401);
    });
  });
});

describe.skipIf(hasDb)("notification routes (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
