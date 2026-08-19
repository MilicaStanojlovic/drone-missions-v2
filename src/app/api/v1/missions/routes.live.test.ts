import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, mission, rating, users } from "@/db/schema";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import type { UserRole } from "@/db/schema";
import { getMissionDao } from "@/features/missions/mission.cache";
import { POST as registerRoute } from "../auth/register/route";
import { GET as feedRoute, POST as createRoute } from "./route";
import { GET as myMissionsRoute } from "./my-missions/route";
import { DELETE as deleteRoute, GET as detailRoute, PUT as updateRoute } from "./[id]/route";

/**
 * Route-level **integration** suite for the phase-2 mission endpoints: the
 * real handlers over the real service, the real caching DAO and a real
 * Postgres, with nothing mocked.
 *
 * This is the live-DB counterpart of `routes.test.ts`, which mocks
 * `MissionService`/`RatingService` exactly as `MissionControllerTest` does and
 * therefore proves only what the web layer contributes. It cannot prove any
 * of what this file is here for, because every one of these behaviours lives
 * *below* the mock boundary:
 *
 * - the two `jsonb` columns actually round-tripping a flight plan, and
 *   `bidding_deadline` coming back as a bare `yyyy-MM-dd` string rather than
 *   an instant (`LocalDate` parity — the one field a driver could silently
 *   turn into a zoned `Date`);
 * - the designer join and the ratings aggregate feeding `designer*` /
 *   `designerRating` off real rows;
 * - the `findById` vs. `findFresh` split doing its job against a live row: an
 *   edit must never write a cached snapshot back over `status`;
 * - the audit rows the three mutations leave behind, and the
 *   `ON DELETE CASCADE` a mission delete relies on;
 * - the dynamic feed `where` (the ported `Specification`) as SQL.
 *
 * It lives in a separate file rather than in `routes.test.ts` because that
 * file's `vi.mock` of the mission service is module-scoped: a live-DB block
 * inside it would still be talking to the mocks.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * the same shape as `src/app/api/v1/auth/routes.test.ts` and
 * `src/lib/audit.test.ts`, which `vitest.config.ts` forwards the variable for.
 *
 * There is no Spring counterpart to mirror here: the backend has no
 * `@SpringBootTest` integration suite (its mission tests are the Mockito
 * `MissionControllerTest`/`MissionServiceTest` already mirrored elsewhere).
 * These cases are therefore written against the *behaviour* the ported source
 * files specify, and each one names the rule it pins.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../web/controller/mission/MissionController.java
 * - drone-missions-backend/.../business/service/mission/MissionService.java
 * - drone-missions-backend/.../data/access/{JpaMissionDao,CachingMissionDao}.java
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("mission routes (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();
  let emailCounter = 0;

  function uniqueEmail(label: string): string {
    emailCounter += 1;
    return `mission-route-${runId}-${emailCounter}-${label}@example.com`;
  }

  const listContext = { params: Promise.resolve({}) };
  const insertedUserIds: number[] = [];

  function idContext(id: number | string) {
    return { params: Promise.resolve({ id: String(id) }) };
  }

  /** The headers `src/middleware.ts` attaches from a verified token's claims. */
  function authHeaders(userId: number, role: UserRole): Record<string, string> {
    return { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role };
  }

  function getRequest(url: string, userId: number, role: UserRole): Request {
    return new Request(url, { headers: authHeaders(userId, role) });
  }

  function jsonRequest(
    url: string,
    method: "POST" | "PUT",
    body: unknown,
    userId: number,
    role: UserRole,
  ): Request {
    return new Request(url, {
      method,
      headers: { "content-type": "application/json", ...authHeaders(userId, role) },
      body: JSON.stringify(body),
    });
  }

  function deleteRequest(url: string, userId: number, role: UserRole): Request {
    return new Request(url, { method: "DELETE", headers: authHeaders(userId, role) });
  }

  async function registerTestUser(role: UserRole, label: string): Promise<number> {
    const response = await registerRoute(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: `mission-${label}`,
          email: uniqueEmail(label),
          password: "password123",
          role,
        }),
      }),
      listContext,
    );
    const body = await response.json();
    expect(response.status).toBe(201);
    insertedUserIds.push(body.id);
    return body.id as number;
  }

  /**
   * An ISO instant for a *local* wall-clock time. The `?date=` filter resolves
   * its day bounds in the server's zone (see `MissionService.dayBounds`), so a
   * flight window pinned to UTC would drift out of the filtered day whenever
   * the suite runs somewhere other than UTC.
   */
  function localInstant(year: number, month: number, day: number, hour: number): string {
    return new Date(year, month - 1, day, hour).toISOString();
  }

  /** A valid `MissionRequest` body; every field the nine-field mapper reads. */
  function missionPayload(overrides: Record<string, unknown> = {}) {
    return {
      name: `Bridge survey ${runId}`,
      description: `Photogrammetry pass over the north span ${runId}`,
      status: "PUBLISHED",
      startTime: localInstant(2026, 9, 1, 8),
      endTime: localInstant(2026, 9, 1, 10),
      location: `Novi Sad ${runId}`,
      biddingDeadline: "2026-08-25",
      waypoints: [
        { lat: 45.2671, lng: 19.8335, altitude: 60, action: "PHOTO" },
        { lat: 45.2681, lng: 19.8345, altitude: 80, action: "HOVER", hoverDurationSeconds: 30 },
      ],
      geofence: {
        type: "CIRCLE",
        center: { lat: 45.2676, lng: 19.834 },
        radiusMeters: 500,
      },
      ...overrides,
    };
  }

  /** Creates a mission through the real endpoint and returns its response body. */
  async function createMission(designerId: number, overrides: Record<string, unknown> = {}) {
    const response = await createRoute(
      jsonRequest(
        "http://localhost/api/v1/missions",
        "POST",
        missionPayload(overrides),
        designerId,
        "DESIGNER",
      ),
      listContext,
    );
    const body = await response.json();
    expect(response.status).toBe(201);
    return body;
  }

  let designerId: number;
  let otherDesignerId: number;
  let pilotId: number;

  beforeAll(async () => {
    designerId = await registerTestUser("DESIGNER", "owner");
    otherDesignerId = await registerTestUser("DESIGNER", "stranger");
    pilotId = await registerTestUser("PILOT", "pilot");
  });

  afterAll(async () => {
    // Missions first: `fk_mission_user` has no cascade (a designer is not
    // deletable out from under their missions), and ratings/bids hang off the
    // mission by a cascading FK.
    if (insertedUserIds.length > 0) {
      await getDb().delete(mission).where(inArray(mission.userId, insertedUserIds));
      // Audit rows deliberately outlive their actor (see `audit_log`'s doc
      // comment in db/schema.ts), so they have to go explicitly.
      await getDb().delete(auditLog).where(inArray(auditLog.actorId, insertedUserIds));
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  describe("POST /api/v1/missions", () => {
    it("persists the mission and answers 201 + Location with the response the client reads", async () => {
      const response = await createRoute(
        jsonRequest(
          "http://localhost/api/v1/missions",
          "POST",
          missionPayload(),
          designerId,
          "DESIGNER",
        ),
        listContext,
      );
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(response.headers.get("location")).toBe(
        `http://localhost/api/v1/missions/${body.id}`,
      );
      expect(body).toMatchObject({
        name: `Bridge survey ${runId}`,
        status: "PUBLISHED",
        // Server-owned fields the request never supplies.
        moderation: "VISIBLE",
        userId: designerId,
        awardedPilotId: null,
        // Off the designer join, not off the request.
        designerName: "mission-owner",
        designerSuspended: false,
        // No ratings yet — `RatingSummary.NONE`.
        designerRating: 0,
        designerRatingCount: 0,
      });
      // A `LocalDate` stays a calendar day over the wire: no time, no zone.
      expect(body.biddingDeadline).toBe("2026-08-25");

      const [row] = await getDb().select().from(mission).where(eq(mission.id, body.id));
      expect(row.userId).toBe(designerId);
      expect(row.moderation).toBe("VISIBLE");
      expect(row.awardedPilotId).toBeNull();
      expect(row.biddingDeadline).toBe("2026-08-25");
      // The two `jsonb` columns round-trip the flight plan unchanged.
      expect(row.waypoints).toEqual([
        { lat: 45.2671, lng: 19.8335, altitude: 60, action: "PHOTO" },
        { lat: 45.2681, lng: 19.8345, altitude: 80, action: "HOVER", hoverDurationSeconds: 30 },
      ]);
      expect(row.geofence).toEqual({
        type: "CIRCLE",
        center: { lat: 45.2676, lng: 19.834 },
        radiusMeters: 500,
      });
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    it("records a MISSION_CREATED audit row naming the mission", async () => {
      const created = await createMission(designerId, { name: `Audited create ${runId}` });

      const [entry] = await getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetId, created.id), eq(auditLog.action, "MISSION_CREATED")));

      expect(entry).toMatchObject({
        actorId: designerId,
        actorRole: "DESIGNER",
        action: "MISSION_CREATED",
        targetType: "MISSION",
        targetId: created.id,
        details: `"Audited create ${runId}"`,
      });
    });

    it("rejects an invalid flight plan with 400 and writes no row", async () => {
      const before = await getDb().select().from(mission).where(eq(mission.userId, designerId));

      const response = await createRoute(
        jsonRequest(
          "http://localhost/api/v1/missions",
          "POST",
          missionPayload({
            waypoints: [
              { lat: 45.2671, lng: 19.8335, altitude: 60, action: "PHOTO" },
              { lat: 45.2681, lng: 19.8345, altitude: 80, action: "HOVER" },
            ],
          }),
          designerId,
          "DESIGNER",
        ),
        listContext,
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.data).toMatchObject({
        "waypoints[1].hoverDurationSeconds": "must be greater than 0 for a HOVER waypoint",
      });

      const after = await getDb().select().from(mission).where(eq(mission.userId, designerId));
      expect(after).toHaveLength(before.length);
    });

    it("refuses a suspended designer with 403 and writes no row", async () => {
      const suspendedId = await registerTestUser("DESIGNER", "suspended");
      await getDb().update(users).set({ suspended: true }).where(eq(users.id, suspendedId));

      const response = await createRoute(
        jsonRequest(
          "http://localhost/api/v1/missions",
          "POST",
          missionPayload({ name: `Suspended create ${runId}` }),
          suspendedId,
          "DESIGNER",
        ),
        listContext,
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.status).toBe("FORBIDDEN");
      expect(await getDb().select().from(mission).where(eq(mission.userId, suspendedId))).toEqual(
        [],
      );
    });
  });

  describe("GET /api/v1/missions/{id}", () => {
    it("returns the persisted mission to its owner, with the designer's real rating aggregate", async () => {
      const created = await createMission(designerId, { name: `Rated mission ${runId}` });
      const now = new Date();
      await getDb()
        .insert(rating)
        .values([
          // Two different raters: `rating_mission_rater_unique` allows one
          // rating per rater per mission.
          {
            missionId: created.id,
            raterId: pilotId,
            rateeId: designerId,
            score: 5,
            createdAt: now,
          },
          {
            missionId: created.id,
            raterId: otherDesignerId,
            rateeId: designerId,
            score: 4,
            createdAt: now,
          },
        ]);

      const response = await detailRoute(
        getRequest(`http://localhost/api/v1/missions/${created.id}`, designerId, "DESIGNER"),
        idContext(created.id),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe(created.id);
      expect(body.designerRating).toBe(4.5);
      expect(body.designerRatingCount).toBe(2);
      expect(body.waypoints).toHaveLength(2);
      expect(body.geofence).toMatchObject({ type: "CIRCLE", radiusMeters: 500 });

      // Clean up the ratings so the designer's aggregate doesn't leak into the
      // later cases in this file (they assert the unrated 0/0 summary).
      await getDb().delete(rating).where(eq(rating.missionId, created.id));
    });

    it("hides another designer's DRAFT behind a 404 — never a 403 — while its owner still reads it", async () => {
      const draft = await createMission(designerId, {
        name: `Secret draft ${runId}`,
        status: "DRAFT",
      });

      const pilotResponse = await detailRoute(
        getRequest(`http://localhost/api/v1/missions/${draft.id}`, pilotId, "PILOT"),
        idContext(draft.id),
      );
      expect(pilotResponse.status).toBe(404);
      expect((await pilotResponse.json()).status).toBe("NOT_FOUND");

      const ownerResponse = await detailRoute(
        getRequest(`http://localhost/api/v1/missions/${draft.id}`, designerId, "DESIGNER"),
        idContext(draft.id),
      );
      expect(ownerResponse.status).toBe(200);
      expect((await ownerResponse.json()).status).toBe("DRAFT");
    });

    it("lets any authenticated caller read a published mission", async () => {
      const published = await createMission(designerId, { name: `Public mission ${runId}` });

      const response = await detailRoute(
        getRequest(`http://localhost/api/v1/missions/${published.id}`, pilotId, "PILOT"),
        idContext(published.id),
      );

      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe(published.id);
    });

    it("answers 404 for an id that does not exist", async () => {
      const response = await detailRoute(
        getRequest("http://localhost/api/v1/missions/999999999", pilotId, "PILOT"),
        idContext(999999999),
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/v1/missions (open feed)", () => {
    it("returns open missions matching the location/keyword/date filters and drops the ones that do not", async () => {
      const target = await createMission(designerId, {
        name: `Feed target ${runId}`,
        location: `Novi Sad ${runId}`,
      });
      await createMission(designerId, {
        name: `Feed elsewhere ${runId}`,
        location: `Subotica ${runId}`,
      });

      // Case-insensitive location match (the SQL lowercases both sides).
      const byLocation = await feedRoute(
        getRequest(
          `http://localhost/api/v1/missions?location=${encodeURIComponent(`NOVI SAD ${runId}`)}`,
          pilotId,
          "PILOT",
        ),
        listContext,
      );
      const located = await byLocation.json();
      expect(byLocation.status).toBe(200);
      expect(located.map((m: { id: number }) => m.id)).toContain(target.id);
      expect(located.every((m: { location: string }) => m.location.includes(runId))).toBe(true);

      // Keyword matches over name OR description.
      const byKeyword = await feedRoute(
        getRequest(
          `http://localhost/api/v1/missions?keyword=${encodeURIComponent(`feed target ${runId}`)}`,
          pilotId,
          "PILOT",
        ),
        listContext,
      );
      const keyed = await byKeyword.json();
      expect(keyed.map((m: { id: number }) => m.id)).toEqual([target.id]);

      // The flight window overlaps the filtered day...
      const onDay = await feedRoute(
        getRequest(
          `http://localhost/api/v1/missions?date=2026-09-01&keyword=${encodeURIComponent(`feed target ${runId}`)}`,
          pilotId,
          "PILOT",
        ),
        listContext,
      );
      expect((await onDay.json()).map((m: { id: number }) => m.id)).toEqual([target.id]);

      // ...and not the day after it.
      const otherDay = await feedRoute(
        getRequest(
          `http://localhost/api/v1/missions?date=2026-09-02&keyword=${encodeURIComponent(`feed target ${runId}`)}`,
          pilotId,
          "PILOT",
        ),
        listContext,
      );
      expect(await otherDay.json()).toEqual([]);
    });

    it("never shows a DRAFT mission to anyone but its owner", async () => {
      const draft = await createMission(designerId, {
        name: `Feed draft ${runId}`,
        status: "DRAFT",
      });

      const response = await feedRoute(
        getRequest(
          `http://localhost/api/v1/missions?keyword=${encodeURIComponent(`feed draft ${runId}`)}`,
          designerId,
          "DESIGNER",
        ),
        listContext,
      );

      expect(await response.json()).toEqual([]);
      expect(draft.status).toBe("DRAFT");
    });

    it("drops a mission whose designer has been suspended once the list cache is invalidated", async () => {
      const suspendedId = await registerTestUser("DESIGNER", "feed-suspended");
      const doomed = await createMission(suspendedId, { name: `Suspended feed ${runId}` });
      const keyword = encodeURIComponent(`suspended feed ${runId}`);

      const before = await feedRoute(
        getRequest(`http://localhost/api/v1/missions?keyword=${keyword}`, pilotId, "PILOT"),
        listContext,
      );
      expect((await before.json()).map((m: { id: number }) => m.id)).toEqual([doomed.id]);

      await getDb().update(users).set({ suspended: true }).where(eq(users.id, suspendedId));
      // Suspension writes to `users`, a table the mission DAO never observes,
      // which is exactly why `invalidateLists()` exists — the Phase-7
      // moderation service must call it for the same reason.
      getMissionDao().invalidateLists();

      const after = await feedRoute(
        getRequest(`http://localhost/api/v1/missions?keyword=${keyword}`, pilotId, "PILOT"),
        listContext,
      );
      expect(await after.json()).toEqual([]);
    });
  });

  describe("GET /api/v1/missions/my-missions", () => {
    it("returns every mission the caller owns whatever its status, and nothing for a stranger", async () => {
      const owner = await registerTestUser("DESIGNER", "mine");
      const published = await createMission(owner, { name: `Mine published ${runId}` });
      const draft = await createMission(owner, { name: `Mine draft ${runId}`, status: "DRAFT" });

      const response = await myMissionsRoute(
        getRequest("http://localhost/api/v1/missions/my-missions", owner, "DESIGNER"),
        listContext,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.map((m: { id: number }) => m.id).sort()).toEqual(
        [published.id, draft.id].sort(),
      );

      // A pilot who owns nothing gets the empty list, not a 403 — the endpoint
      // is authenticated-only by design.
      const pilotResponse = await myMissionsRoute(
        getRequest("http://localhost/api/v1/missions/my-missions", pilotId, "PILOT"),
        listContext,
      );
      expect(pilotResponse.status).toBe(200);
      expect(await pilotResponse.json()).toEqual([]);
    });
  });

  describe("PUT /api/v1/missions/{id}", () => {
    it("applies the owner's edit, leaves the lifecycle status alone, and audits it", async () => {
      const created = await createMission(designerId, { name: `Editable ${runId}` });

      // Warm the entity cache with the mission as it is now, then move it on
      // in the database behind the cache's back — the shape of a lifecycle
      // transition (Phase 5) or a bid landing (Phase 3). The edit below must
      // still see BIDDING, because `update` loads through `findFresh`.
      await detailRoute(
        getRequest(`http://localhost/api/v1/missions/${created.id}`, designerId, "DESIGNER"),
        idContext(created.id),
      );
      await getDb().update(mission).set({ status: "BIDDING" }).where(eq(mission.id, created.id));

      const response = await updateRoute(
        jsonRequest(
          `http://localhost/api/v1/missions/${created.id}`,
          "PUT",
          missionPayload({
            name: `Edited ${runId}`,
            description: `Revised sweep ${runId}`,
            location: `Zrenjanin ${runId}`,
            // A client-supplied status is ignored by `update`, exactly as the
            // source never copies it across.
            status: "DRAFT",
            biddingDeadline: "2026-08-30",
            geofence: {
              type: "POLYGON",
              points: [
                { lat: 45.26, lng: 19.83 },
                { lat: 45.27, lng: 19.83 },
                { lat: 45.27, lng: 19.84 },
              ],
            },
          }),
          designerId,
          "DESIGNER",
        ),
        idContext(created.id),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        id: created.id,
        name: `Edited ${runId}`,
        location: `Zrenjanin ${runId}`,
        biddingDeadline: "2026-08-30",
        // Neither the request's DRAFT nor the pre-edit PUBLISHED: the live row's.
        status: "BIDDING",
        userId: designerId,
      });
      expect(body.geofence).toEqual({
        type: "POLYGON",
        points: [
          { lat: 45.26, lng: 19.83 },
          { lat: 45.27, lng: 19.83 },
          { lat: 45.27, lng: 19.84 },
        ],
      });

      const [row] = await getDb().select().from(mission).where(eq(mission.id, created.id));
      expect(row.name).toBe(`Edited ${runId}`);
      expect(row.status).toBe("BIDDING");
      expect(row.createdAt.getTime()).toBe(new Date(created.createdAt).getTime());
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());

      const [entry] = await getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetId, created.id), eq(auditLog.action, "MISSION_UPDATED")));
      expect(entry).toMatchObject({
        actorId: designerId,
        actorRole: "DESIGNER",
        targetType: "MISSION",
        details: `"Edited ${runId}"`,
      });
    });

    it("rejects a non-owner with 403 and leaves the row untouched", async () => {
      const created = await createMission(designerId, { name: `Not yours ${runId}` });

      const response = await updateRoute(
        jsonRequest(
          `http://localhost/api/v1/missions/${created.id}`,
          "PUT",
          missionPayload({ name: `Hijacked ${runId}` }),
          otherDesignerId,
          "DESIGNER",
        ),
        idContext(created.id),
      );

      expect(response.status).toBe(403);
      expect((await response.json()).status).toBe("FORBIDDEN");

      const [row] = await getDb().select().from(mission).where(eq(mission.id, created.id));
      expect(row.name).toBe(`Not yours ${runId}`);
    });
  });

  describe("DELETE /api/v1/missions/{id}", () => {
    it("removes the row, cascades its ratings, audits the deletion, and 404s the second time", async () => {
      const created = await createMission(designerId, { name: `Doomed ${runId}` });
      await getDb().insert(rating).values({
        missionId: created.id,
        raterId: pilotId,
        rateeId: designerId,
        score: 3,
        createdAt: new Date(),
      });

      const response = await deleteRoute(
        deleteRequest(
          `http://localhost/api/v1/missions/${created.id}`,
          designerId,
          "DESIGNER",
        ),
        idContext(created.id),
      );

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(await getDb().select().from(mission).where(eq(mission.id, created.id))).toEqual([]);
      // `fk_rating_mission ON DELETE CASCADE` — the ratings go with it.
      expect(await getDb().select().from(rating).where(eq(rating.missionId, created.id))).toEqual(
        [],
      );

      const [entry] = await getDb()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetId, created.id), eq(auditLog.action, "MISSION_DELETED")));
      expect(entry).toMatchObject({
        actorId: designerId,
        actorRole: "DESIGNER",
        targetType: "MISSION",
        details: `"Doomed ${runId}"`,
      });

      const second = await deleteRoute(
        deleteRequest(
          `http://localhost/api/v1/missions/${created.id}`,
          designerId,
          "DESIGNER",
        ),
        idContext(created.id),
      );
      expect(second.status).toBe(404);
    });

    it("rejects a non-owner with 403 and keeps the mission", async () => {
      const created = await createMission(designerId, { name: `Survivor ${runId}` });

      const response = await deleteRoute(
        deleteRequest(
          `http://localhost/api/v1/missions/${created.id}`,
          otherDesignerId,
          "DESIGNER",
        ),
        idContext(created.id),
      );

      expect(response.status).toBe(403);
      expect(await getDb().select().from(mission).where(eq(mission.id, created.id))).toHaveLength(
        1,
      );
    });
  });
});

describe.skipIf(hasDb)("mission routes (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
