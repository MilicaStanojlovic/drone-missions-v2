import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, bid, mission, notification, rating, users } from "@/db/schema";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import type { UserRole } from "@/db/schema";
import { getMissionDao } from "@/features/missions/server/mission.cache";
import { POST as registerRoute } from "@/app/api/v1/auth/register/route";
import { POST as placeBidRoute } from "@/app/api/v1/bids/mission/[missionId]/route";
import { POST as acceptBidRoute } from "@/app/api/v1/bids/[id]/accept/route";
import { GET as feedRoute, POST as createRoute } from "@/app/api/v1/missions/route";
import { GET as adminListRoute } from "@/app/api/v1/missions/all/route";
import { POST as hideRoute } from "@/app/api/v1/missions/[id]/hide/route";
import { POST as unhideRoute } from "@/app/api/v1/missions/[id]/unhide/route";
import { POST as removeRoute } from "@/app/api/v1/missions/[id]/remove/route";
import { GET as myMissionsRoute } from "@/app/api/v1/missions/my-missions/route";
import { GET as myJobsRoute } from "@/app/api/v1/missions/my-jobs/route";
import { DELETE as deleteRoute, GET as detailRoute, PUT as updateRoute } from "@/app/api/v1/missions/[id]/route";
import { POST as startRoute } from "@/app/api/v1/missions/[id]/start/route";
import { POST as completeRoute } from "@/app/api/v1/missions/[id]/complete/route";
import { POST as cancelRoute } from "@/app/api/v1/missions/[id]/cancel/route";

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
 * - the dynamic feed `where` (the ported `Specification`) as SQL;
 * - the phase-5 lifecycle over real rows: `/start` and `/complete` walking one
 *   awarded mission AWARDED -> IN_PROGRESS -> COMPLETED and auditing each step
 *   while raising no notification at all, `/cancel` rejecting every
 *   outstanding bid in the same transaction and telling the awarded pilot, and
 *   the post-write cache eviction that makes each transition visible to the
 *   very next read;
 * - `/my-jobs` served off the caching DAO's own `byPilot` list key — a listing
 *   that must both appear the moment a bid is accepted and survive the mission
 *   leaving the open marketplace;
 * - and the negative of the flagged plan-vs-source finding: reading a mission
 *   whose `startTime` is long past never promotes it to IN_PROGRESS, because
 *   the source has no such lazy transition;
 * - the phase-7 moderation surface over real rows: `/all` listing what the
 *   feed deliberately hides (drafts, hidden and cancelled missions) *and*
 *   surviving an ownerless legacy row through its LEFT join, `/hide` and
 *   `/unhide` walking one mission out of and back into the live marketplace
 *   with the cache eviction that makes each direction visible to the very next
 *   feed read, and `/remove` hard-deleting a mission whose bids, notifications
 *   and ratings cascade away with it while the audit row survives — the whole
 *   point of the audit target not being a foreign key.
 *
 * It lives in a separate file rather than in `routes.test.ts` because that
 * file's `vi.mock` of the mission service is module-scoped: a live-DB block
 * inside it would still be talking to the mocks.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * the same shape as `tests/app/api/v1/auth/routes.test.ts` and
 * `tests/lib/audit.test.ts`, which `vitest.config.ts` forwards the variable for.
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

  /** A lifecycle POST as the client sends it: path plus token, no body. */
  function postRequest(url: string, userId: number, role: UserRole): Request {
    return new Request(url, { method: "POST", headers: authHeaders(userId, role) });
  }

  /** The context the bid-placement route matches — its segment is `missionId`. */
  function missionContext(missionId: number) {
    return { params: Promise.resolve({ missionId: String(missionId) }) };
  }

  /**
   * Drives a mission all the way to AWARDED through the *real* bid endpoints,
   * rather than writing the status and `awarded_pilot_id` straight into the
   * table. The award is the precondition every lifecycle case needs, and
   * faking it would also fake the cache state: `POST /bids/{id}/accept` is what
   * invalidates the DAO's list keys (`/my-jobs` reads one of them), so a
   * hand-written row would leave the caching decorator holding a pre-award
   * snapshot that no production path could produce.
   *
   * Returns the winning bid and any losers, so a case can assert what the
   * cancellation cascade does to each.
   */
  async function awardMission(
    missionId: number,
    winnerId: number,
    loserIds: number[] = [],
  ): Promise<{ winningBidId: number; losingBidIds: number[] }> {
    const winning = await placeBid(missionId, winnerId, 1000);
    const losing: number[] = [];
    for (const loserId of loserIds) {
      losing.push(await placeBid(missionId, loserId, 1200));
    }
    const accepted = await acceptBidRoute(
      postRequest(`http://localhost/api/v1/bids/${winning}/accept`, designerId, "DESIGNER"),
      idContext(winning),
    );
    expect(accepted.status).toBe(200);
    return { winningBidId: winning, losingBidIds: losing };
  }

  /** Places one bid through `POST /api/v1/bids/mission/{missionId}` and returns its id. */
  async function placeBid(missionId: number, pilotId: number, amount: number): Promise<number> {
    const response = await placeBidRoute(
      jsonRequest(
        `http://localhost/api/v1/bids/mission/${missionId}`,
        "POST",
        { amount, message: `Bid from ${pilotId}` },
        pilotId,
        "PILOT",
      ),
      missionContext(missionId),
    );
    const body = await response.json();
    // 200, not 201: placing a bid is an upsert (`bid_mission_pilot_unique`),
    // so the source returns the bid rather than creating a new resource.
    expect(response.status).toBe(200);
    return body.id as number;
  }

  /** Every audit row written about one mission, in no particular order. */
  async function auditRowsFor(missionId: number) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetType, "MISSION"), eq(auditLog.targetId, missionId)));
  }

  /** Every notification raised for one user about one mission. */
  async function notificationsFor(userId: number, missionId: number) {
    return getDb()
      .select()
      .from(notification)
      .where(and(eq(notification.userId, userId), eq(notification.missionId, missionId)));
  }

  let designerId: number;
  let otherDesignerId: number;
  let pilotId: number;
  let otherPilotId: number;
  let adminId: number;

  /**
   * Ownerless missions this suite inserts directly (`user_id` null), which the
   * owner-scoped cleanup below cannot reach.
   */
  const ownerlessMissionIds: number[] = [];

  /**
   * Seeds an ADMIN straight into the table. `/api/v1/auth/register` refuses the
   * role by design — a deployment gets its first admin from the V12 seed
   * migration — and the moderation handlers only need a verified principal on
   * the headers, never a password.
   */
  async function seedAdmin(): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: "mission-admin",
        email: uniqueEmail("admin"),
        passwordHash: "not-a-real-hash",
        role: "ADMIN",
        suspended: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id });
    insertedUserIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    designerId = await registerTestUser("DESIGNER", "owner");
    otherDesignerId = await registerTestUser("DESIGNER", "stranger");
    pilotId = await registerTestUser("PILOT", "pilot");
    // The losing bidder / the pilot with no claim on someone else's job.
    otherPilotId = await registerTestUser("PILOT", "other-pilot");
    adminId = await seedAdmin();
  });

  afterAll(async () => {
    // Missions first: `fk_mission_user` has no cascade (a designer is not
    // deletable out from under their missions), and ratings/bids hang off the
    // mission by a cascading FK.
    if (ownerlessMissionIds.length > 0) {
      await getDb().delete(mission).where(inArray(mission.id, ownerlessMissionIds));
    }
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

  describe("the lifecycle endpoints over real rows", () => {
    /**
     * A mission a pilot can still bid on: the shared `missionPayload` deadline
     * is a fixed near-term day, and these fixtures must keep working long after
     * it passes (`BidService` refuses a bid past the deadline).
     */
    async function biddableMission(name: string) {
      return createMission(designerId, {
        name: `${name} ${runId}`,
        startTime: localInstant(2030, 9, 1, 8),
        endTime: localInstant(2030, 9, 1, 10),
        biddingDeadline: "2030-08-25",
      });
    }

    /** An awarded mission plus its winning pilot — the state every case starts from. */
    async function awardedMission(name: string, loserIds: number[] = []) {
      const created = await biddableMission(name);
      const bids = await awardMission(created.id, pilotId, loserIds);
      return { ...created, ...bids };
    }

    describe("POST /api/v1/missions/{id}/start", () => {
      it("moves an awarded mission to IN_PROGRESS, audits it, notifies nobody, and is visible to the next read", async () => {
        const awarded = await awardedMission("Startable");
        // Warm the entity cache with the pre-start row, so the last assertion
        // is really about the write path's eviction and not about a cold cache.
        await detailRoute(
          getRequest(`http://localhost/api/v1/missions/${awarded.id}`, pilotId, "PILOT"),
          idContext(awarded.id),
        );

        const response = await startRoute(
          postRequest(`http://localhost/api/v1/missions/${awarded.id}/start`, pilotId, "PILOT"),
          idContext(awarded.id),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          id: awarded.id,
          status: "IN_PROGRESS",
          awardedPilotId: pilotId,
          userId: designerId,
        });

        const [row] = await getDb().select().from(mission).where(eq(mission.id, awarded.id));
        expect(row.status).toBe("IN_PROGRESS");
        expect(row.awardedPilotId).toBe(pilotId);

        // Actored by the *pilot*, not the designer — `NewAuditEntry.missionStarted`.
        const started = (await auditRowsFor(awarded.id)).filter(
          (entry) => entry.action === "MISSION_STARTED",
        );
        expect(started).toHaveLength(1);
        expect(started[0]).toMatchObject({
          actorId: pilotId,
          actorRole: "PILOT",
          targetType: "MISSION",
          details: `"Startable ${runId}"`,
        });

        // No notification and no email: the source announces only cancellation.
        // The designer's one NEW_BID is the fixture's own bid, raised by
        // `place`, not by `start` — which is exactly what "notifies nobody"
        // has to mean now that a bid tells the designer something.
        expect((await notificationsFor(designerId, awarded.id)).map((note) => note.type)).toEqual([
          "NEW_BID",
        ]);
        const pilotNotes = await notificationsFor(pilotId, awarded.id);
        expect(pilotNotes.map((note) => note.type)).toEqual(["BID_ACCEPTED"]);

        const detail = await detailRoute(
          getRequest(`http://localhost/api/v1/missions/${awarded.id}`, pilotId, "PILOT"),
          idContext(awarded.id),
        );
        expect((await detail.json()).status).toBe("IN_PROGRESS");
      });

      it("refuses a pilot who is not the awarded one with 403 and leaves the mission AWARDED", async () => {
        const awarded = await awardedMission("Not your job");

        const response = await startRoute(
          postRequest(
            `http://localhost/api/v1/missions/${awarded.id}/start`,
            otherPilotId,
            "PILOT",
          ),
          idContext(awarded.id),
        );
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.message).toBe(`You are not allowed to modify mission ${awarded.id}`);
        const [row] = await getDb().select().from(mission).where(eq(mission.id, awarded.id));
        expect(row.status).toBe("AWARDED");
      });

      it("409s on a mission that was never awarded, naming the status it refused", async () => {
        const published = await biddableMission("Never awarded");
        // A pilot with no claim on it at all: the awarded-pilot guard fires
        // first, so this is a 403 rather than the conflict...
        const strangerResponse = await startRoute(
          postRequest(`http://localhost/api/v1/missions/${published.id}/start`, pilotId, "PILOT"),
          idContext(published.id),
        );
        expect(strangerResponse.status).toBe(403);

        // ...and the conflict is what the awarded pilot of a *reset* mission
        // sees. Written directly, because no endpoint moves a mission back.
        await getDb()
          .update(mission)
          .set({ status: "PUBLISHED", awardedPilotId: pilotId })
          .where(eq(mission.id, published.id));

        const response = await startRoute(
          postRequest(`http://localhost/api/v1/missions/${published.id}/start`, pilotId, "PILOT"),
          idContext(published.id),
        );
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.message).toBe(
          `Mission ${published.id} cannot be started from status PUBLISHED`,
        );
      });

      it("409s on a second start, because the mission is already underway", async () => {
        const awarded = await awardedMission("Started once");
        expect(
          (
            await startRoute(
              postRequest(`http://localhost/api/v1/missions/${awarded.id}/start`, pilotId, "PILOT"),
              idContext(awarded.id),
            )
          ).status,
        ).toBe(200);

        const response = await startRoute(
          postRequest(`http://localhost/api/v1/missions/${awarded.id}/start`, pilotId, "PILOT"),
          idContext(awarded.id),
        );

        expect(response.status).toBe(409);
        expect((await response.json()).message).toBe(
          `Mission ${awarded.id} cannot be started from status IN_PROGRESS`,
        );
      });

      it("403s while the awarded pilot's own account is suspended, and works again once it is lifted", async () => {
        const frozenPilot = await registerTestUser("PILOT", "frozen");
        const created = await biddableMission("Frozen pilot");
        await awardMission(created.id, frozenPilot);
        await getDb().update(users).set({ suspended: true }).where(eq(users.id, frozenPilot));

        const response = await startRoute(
          postRequest(`http://localhost/api/v1/missions/${created.id}/start`, frozenPilot, "PILOT"),
          idContext(created.id),
        );
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.message).toBe("This account is suspended and cannot perform this action");
        const [row] = await getDb().select().from(mission).where(eq(mission.id, created.id));
        expect(row.status).toBe("AWARDED");

        await getDb().update(users).set({ suspended: false }).where(eq(users.id, frozenPilot));
        expect(
          (
            await startRoute(
              postRequest(
                `http://localhost/api/v1/missions/${created.id}/start`,
                frozenPilot,
                "PILOT",
              ),
              idContext(created.id),
            )
          ).status,
        ).toBe(200);
      });

      it("never advances a mission on read alone, however long its start time has passed", async () => {
        // The flagged plan-vs-source finding, pinned from the outside: the
        // phase spec claimed AWARDED -> IN_PROGRESS happens lazily once
        // `startTime` is behind us. The Spring source has no such path, so a
        // read of an overdue awarded mission must still say AWARDED.
        const awarded = await awardedMission("Overdue but idle");
        await getDb()
          .update(mission)
          .set({
            startTime: new Date("2020-01-01T08:00:00Z"),
            endTime: new Date("2020-01-01T10:00:00Z"),
          })
          .where(eq(mission.id, awarded.id));
        getMissionDao().invalidate(awarded.id);

        const detail = await detailRoute(
          getRequest(`http://localhost/api/v1/missions/${awarded.id}`, pilotId, "PILOT"),
          idContext(awarded.id),
        );
        expect((await detail.json()).status).toBe("AWARDED");

        const jobs = await myJobsRoute(
          getRequest("http://localhost/api/v1/missions/my-jobs", pilotId, "PILOT"),
          listContext,
        );
        const listed = (await jobs.json()).find((m: { id: number }) => m.id === awarded.id);
        expect(listed.status).toBe("AWARDED");

        const [row] = await getDb().select().from(mission).where(eq(mission.id, awarded.id));
        expect(row.status).toBe("AWARDED");
        expect(
          (await auditRowsFor(awarded.id)).some((entry) => entry.action === "MISSION_STARTED"),
        ).toBe(false);
      });
    });

    describe("POST /api/v1/missions/{id}/complete", () => {
      it("walks the mission AWARDED -> IN_PROGRESS -> COMPLETED and audits the finish", async () => {
        const awarded = await awardedMission("Completable");
        await startRoute(
          postRequest(`http://localhost/api/v1/missions/${awarded.id}/start`, pilotId, "PILOT"),
          idContext(awarded.id),
        );

        const response = await completeRoute(
          postRequest(`http://localhost/api/v1/missions/${awarded.id}/complete`, pilotId, "PILOT"),
          idContext(awarded.id),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ id: awarded.id, status: "COMPLETED", awardedPilotId: pilotId });

        const [row] = await getDb().select().from(mission).where(eq(mission.id, awarded.id));
        expect(row.status).toBe("COMPLETED");

        const actions = (await auditRowsFor(awarded.id)).map((entry) => entry.action).sort();
        expect(actions).toEqual(["MISSION_COMPLETED", "MISSION_CREATED", "MISSION_STARTED"]);
        const [completed] = (await auditRowsFor(awarded.id)).filter(
          (entry) => entry.action === "MISSION_COMPLETED",
        );
        expect(completed).toMatchObject({
          actorId: pilotId,
          actorRole: "PILOT",
          details: `"Completable ${runId}"`,
        });

        // Still nothing announced — the same silence as `start`. The lone
        // NEW_BID is the fixture's bid (see the `start` case above).
        expect((await notificationsFor(designerId, awarded.id)).map((note) => note.type)).toEqual([
          "NEW_BID",
        ]);
      });

      it("409s on a mission that was awarded but never started", async () => {
        const awarded = await awardedMission("Not started");

        const response = await completeRoute(
          postRequest(`http://localhost/api/v1/missions/${awarded.id}/complete`, pilotId, "PILOT"),
          idContext(awarded.id),
        );

        expect(response.status).toBe(409);
        expect((await response.json()).message).toBe(
          `Mission ${awarded.id} cannot be completed from status AWARDED`,
        );
        const [row] = await getDb().select().from(mission).where(eq(mission.id, awarded.id));
        expect(row.status).toBe("AWARDED");
      });

      it("refuses the designer with 403 — completing is the pilot's act (hasRole('PILOT'))", async () => {
        const awarded = await awardedMission("Designer cannot finish");
        await startRoute(
          postRequest(`http://localhost/api/v1/missions/${awarded.id}/start`, pilotId, "PILOT"),
          idContext(awarded.id),
        );

        const response = await completeRoute(
          postRequest(
            `http://localhost/api/v1/missions/${awarded.id}/complete`,
            designerId,
            "DESIGNER",
          ),
          idContext(awarded.id),
        );

        expect(response.status).toBe(403);
        const [row] = await getDb().select().from(mission).where(eq(mission.id, awarded.id));
        expect(row.status).toBe("IN_PROGRESS");
      });
    });

    describe("POST /api/v1/missions/{id}/cancel", () => {
      it("cancels an awarded mission, rejects every outstanding bid, and tells the awarded pilot", async () => {
        const awarded = await awardedMission("Cancellable", [otherPilotId]);

        const response = await cancelRoute(
          postRequest(
            `http://localhost/api/v1/missions/${awarded.id}/cancel`,
            designerId,
            "DESIGNER",
          ),
          idContext(awarded.id),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ id: awarded.id, status: "CANCELLED" });

        const [row] = await getDb().select().from(mission).where(eq(mission.id, awarded.id));
        expect(row.status).toBe("CANCELLED");
        // The award is not undone — the row still records who had won it.
        expect(row.awardedPilotId).toBe(pilotId);

        // Both the winner's ACCEPTED bid and the loser's already-REJECTED one
        // end up REJECTED: "outstanding" covers PENDING *and* ACCEPTED.
        const rows = await getDb().select().from(bid).where(eq(bid.missionId, awarded.id));
        expect(rows.map((r) => r.status)).toEqual(["REJECTED", "REJECTED"]);

        // Only the awarded pilot is told; the loser already had their rejection.
        const winnerNotes = await notificationsFor(pilotId, awarded.id);
        expect(winnerNotes.map((note) => note.type).sort()).toEqual([
          "BID_ACCEPTED",
          "MISSION_CANCELLED",
        ]);
        const [cancelledNote] = winnerNotes.filter((note) => note.type === "MISSION_CANCELLED");
        expect(cancelledNote).toMatchObject({
          title: "Mission cancelled",
          message: `"Cancellable ${runId}" was cancelled by the designer.`,
        });
        expect(
          (await notificationsFor(otherPilotId, awarded.id)).map((note) => note.type),
        ).toEqual(["BID_REJECTED"]);

        // One row per intent: the rejected bids are not audited.
        const cancelAudits = (await auditRowsFor(awarded.id)).filter(
          (entry) => entry.action === "MISSION_CANCELLED",
        );
        expect(cancelAudits).toHaveLength(1);
        expect(cancelAudits[0]).toMatchObject({
          actorId: designerId,
          actorRole: "DESIGNER",
          targetType: "MISSION",
          details: `"Cancellable ${runId}"`,
        });

        const detail = await detailRoute(
          getRequest(`http://localhost/api/v1/missions/${awarded.id}`, designerId, "DESIGNER"),
          idContext(awarded.id),
        );
        expect((await detail.json()).status).toBe("CANCELLED");
      });

      it("cancels a mission that was never awarded, rejecting its pending bids and notifying nobody", async () => {
        const target = await biddableMission("Cancelled early");
        const pending = await placeBid(target.id, pilotId, 400);

        const response = await cancelRoute(
          postRequest(
            `http://localhost/api/v1/missions/${target.id}/cancel`,
            designerId,
            "DESIGNER",
          ),
          idContext(target.id),
        );

        expect(response.status).toBe(200);
        const [row] = await getDb().select().from(bid).where(eq(bid.id, pending));
        expect(row.status).toBe("REJECTED");
        // `awarded_pilot_id` is null, so there is no one to announce it to.
        expect(await notificationsFor(pilotId, target.id)).toEqual([]);
      });

      it("refuses a designer who does not own the mission with 403 and changes nothing", async () => {
        const awarded = await awardedMission("Not yours to cancel");

        const response = await cancelRoute(
          postRequest(
            `http://localhost/api/v1/missions/${awarded.id}/cancel`,
            otherDesignerId,
            "DESIGNER",
          ),
          idContext(awarded.id),
        );

        expect(response.status).toBe(403);
        const [row] = await getDb().select().from(mission).where(eq(mission.id, awarded.id));
        expect(row.status).toBe("AWARDED");
        const [bidRow] = await getDb()
          .select()
          .from(bid)
          .where(eq(bid.id, awarded.winningBidId));
        expect(bidRow.status).toBe("ACCEPTED");
      });

      it("409s on an already-completed mission and on a second cancellation", async () => {
        const awarded = await awardedMission("Finished then cancelled");
        await startRoute(
          postRequest(`http://localhost/api/v1/missions/${awarded.id}/start`, pilotId, "PILOT"),
          idContext(awarded.id),
        );
        await completeRoute(
          postRequest(`http://localhost/api/v1/missions/${awarded.id}/complete`, pilotId, "PILOT"),
          idContext(awarded.id),
        );

        const response = await cancelRoute(
          postRequest(
            `http://localhost/api/v1/missions/${awarded.id}/cancel`,
            designerId,
            "DESIGNER",
          ),
          idContext(awarded.id),
        );
        expect(response.status).toBe(409);
        expect((await response.json()).message).toBe(
          `Mission ${awarded.id} cannot be cancelled from status COMPLETED`,
        );

        const second = await awardedMission("Cancelled twice");
        expect(
          (
            await cancelRoute(
              postRequest(
                `http://localhost/api/v1/missions/${second.id}/cancel`,
                designerId,
                "DESIGNER",
              ),
              idContext(second.id),
            )
          ).status,
        ).toBe(200);
        const repeat = await cancelRoute(
          postRequest(
            `http://localhost/api/v1/missions/${second.id}/cancel`,
            designerId,
            "DESIGNER",
          ),
          idContext(second.id),
        );
        expect(repeat.status).toBe(409);
        expect((await repeat.json()).message).toBe(
          `Mission ${second.id} cannot be cancelled from status CANCELLED`,
        );
      });
    });

    describe("GET /api/v1/missions/my-jobs", () => {
      it("lists a mission the moment it is awarded and keeps it through every later status", async () => {
        const jobPilot = await registerTestUser("PILOT", "jobs");
        const before = await myJobsRoute(
          getRequest("http://localhost/api/v1/missions/my-jobs", jobPilot, "PILOT"),
          listContext,
        );
        expect(before.status).toBe(200);
        expect(await before.json()).toEqual([]);

        const created = await biddableMission("Jobs listing");
        await awardMission(created.id, jobPilot);

        // The accept wrote the mission, which invalidates the DAO's list keys —
        // so the pilot's jobs list already has it, with no cache warm-up.
        const awardedList = await myJobsRoute(
          getRequest("http://localhost/api/v1/missions/my-jobs", jobPilot, "PILOT"),
          listContext,
        );
        const awardedBody = await awardedList.json();
        expect(awardedBody.map((m: { id: number }) => m.id)).toEqual([created.id]);
        expect(awardedBody[0]).toMatchObject({
          status: "AWARDED",
          awardedPilotId: jobPilot,
          // Off the designer join and the ratings aggregate, exactly as the
          // feed's rows are — `toResponses` is the same call.
          designerName: "mission-owner",
          designerRating: 0,
          designerRatingCount: 0,
        });

        await startRoute(
          postRequest(`http://localhost/api/v1/missions/${created.id}/start`, jobPilot, "PILOT"),
          idContext(created.id),
        );
        await completeRoute(
          postRequest(`http://localhost/api/v1/missions/${created.id}/complete`, jobPilot, "PILOT"),
          idContext(created.id),
        );

        // COMPLETED is outside the open statuses, so the mission has left the
        // marketplace — but a job is not a listing, and it stays.
        const after = await myJobsRoute(
          getRequest("http://localhost/api/v1/missions/my-jobs", jobPilot, "PILOT"),
          listContext,
        );
        const afterBody = await after.json();
        expect(afterBody.map((m: { id: number }) => m.id)).toEqual([created.id]);
        expect(afterBody[0].status).toBe("COMPLETED");
      });

      it("shows a pilot only their own jobs, and refuses a designer with 403", async () => {
        const mine = await registerTestUser("PILOT", "jobs-mine");
        const theirs = await registerTestUser("PILOT", "jobs-theirs");
        const myJob = await biddableMission("My job");
        const theirJob = await biddableMission("Their job");
        await awardMission(myJob.id, mine);
        await awardMission(theirJob.id, theirs);

        const response = await myJobsRoute(
          getRequest("http://localhost/api/v1/missions/my-jobs", mine, "PILOT"),
          listContext,
        );
        expect((await response.json()).map((m: { id: number }) => m.id)).toEqual([myJob.id]);

        // Stricter than `/my-missions`, which is `isAuthenticated()`: the
        // source guards this one with `hasRole('PILOT')`.
        const designerResponse = await myJobsRoute(
          getRequest("http://localhost/api/v1/missions/my-jobs", designerId, "DESIGNER"),
          listContext,
        );
        expect(designerResponse.status).toBe(403);
        expect((await designerResponse.json()).status).toBe("FORBIDDEN");
      });
    });
  });

  describe("the moderation endpoints over real rows", () => {
    /** Scopes every `?q` search below to this block's own fixtures. */
    const tag = `moderation-${runId}`;

    /** A mission whose name carries the block's tag, so `?q=` can find it. */
    async function moderatedMission(label: string, overrides: Record<string, unknown> = {}) {
      return createMission(designerId, {
        name: `Moderated ${label} ${tag}`,
        startTime: localInstant(2030, 9, 1, 8),
        endTime: localInstant(2030, 9, 1, 10),
        biddingDeadline: "2030-08-25",
        ...overrides,
      });
    }

    /** One page of `GET /api/v1/missions/all`, as the admin table fetches it. */
    async function adminList(query: string, userId = adminId, role: UserRole = "ADMIN") {
      const response = await adminListRoute(
        getRequest(`http://localhost/api/v1/missions/all${query}`, userId, role),
        listContext,
      );
      return { response, body: await response.json() };
    }

    /** The live `mission` row, straight from the table. */
    async function missionRow(id: number) {
      const [row] = await getDb().select().from(mission).where(eq(mission.id, id));
      return row;
    }

    describe("GET /api/v1/missions/all", () => {
      it("lists every mission there is — including the ones the open feed deliberately withholds", async () => {
        const published = await moderatedMission("published");
        const draft = await moderatedMission("draft", { status: "DRAFT" });
        const hidden = await moderatedMission("hidden");
        expect(
          (
            await hideRoute(
              postRequest(`http://localhost/api/v1/missions/${hidden.id}/hide`, adminId, "ADMIN"),
              idContext(hidden.id),
            )
          ).status,
        ).toBe(200);

        const { response, body } = await adminList(`?q=${encodeURIComponent(tag)}&size=2000`);

        expect(response.status).toBe(200);
        // `new PagedModel<>(…)` field-for-field — the same envelope the users
        // and audit-log listings speak.
        expect(Object.keys(body).sort()).toEqual(["content", "page"]);
        expect(Object.keys(body.page).sort()).toEqual([
          "number",
          "size",
          "totalElements",
          "totalPages",
        ]);
        const ids = body.content.map((m: { id: number }) => m.id);
        expect(ids).toContain(published.id);
        // Neither of these is reachable through `GET /api/v1/missions`: a DRAFT
        // belongs to its owner alone, and a HIDDEN mission has left the
        // marketplace. The admin table is the one list that must show both.
        expect(ids).toContain(draft.id);
        expect(ids).toContain(hidden.id);
        expect(body.content.find((m: { id: number }) => m.id === hidden.id).moderation).toBe(
          "HIDDEN",
        );
        expect(body.page.totalElements).toBe(body.content.length);
        // Newest-created first, the `@PageableDefault(sort = "createdAt")`.
        expect(ids.indexOf(hidden.id)).toBeLessThan(ids.indexOf(published.id));

        const feed = await feedRoute(
          getRequest(
            `http://localhost/api/v1/missions?keyword=${encodeURIComponent(tag)}`,
            pilotId,
            "PILOT",
          ),
          listContext,
        );
        const feedIds = (await feed.json()).map((m: { id: number }) => m.id);
        expect(feedIds).toContain(published.id);
        expect(feedIds).not.toContain(draft.id);
        expect(feedIds).not.toContain(hidden.id);
      });

      it("keeps an ownerless legacy mission, reporting the NONE rating rather than dropping the row", async () => {
        // The LEFT join the repository's own comment calls load-bearing:
        // navigating `m.designer.username` would inner-join and silently lose
        // every pre-auth mission from the one list that must show them all.
        const now = new Date();
        const [row] = await getDb()
          .insert(mission)
          .values({
            name: `Ownerless ${tag}`,
            description: `Legacy row ${tag}`,
            status: "PUBLISHED",
            moderation: "VISIBLE",
            userId: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: mission.id });
        ownerlessMissionIds.push(row.id);

        const { body } = await adminList(`?q=${encodeURIComponent(tag)}&size=2000`);
        const listed = body.content.find((m: { id: number }) => m.id === row.id);

        expect(listed).toBeDefined();
        expect(listed).toMatchObject({
          userId: null,
          designerName: null,
          designerEmail: null,
          // Not null-propagated — a primitive `boolean` in the source.
          designerSuspended: false,
          // `RatingSummary.NONE`: the ownerless ids never reach the aggregate
          // query, and the mapper answers for them without a lookup.
          designerRating: 0,
          designerRatingCount: 0,
        });
      });

      it("matches `?q` against the mission name or the designer's username, case-insensitively", async () => {
        const target = await moderatedMission("searchable");

        const byName = await adminList(
          `?q=${encodeURIComponent(`MODERATED SEARCHABLE ${tag}`)}&size=2000`,
        );
        expect(byName.body.content.map((m: { id: number }) => m.id)).toEqual([target.id]);

        // The other half of the OR: the designer's username, which no mission
        // name contains.
        const byDesigner = await adminList("?q=MISSION-OWNER&size=2000");
        expect(byDesigner.body.content.map((m: { id: number }) => m.id)).toContain(target.id);
        expect(
          byDesigner.body.content.every(
            (m: { designerName: string | null }) => m.designerName === "mission-owner",
          ),
        ).toBe(true);

        // A blank `q` means everything, not nothing.
        const blank = await adminList("?q=%20&size=1");
        expect(blank.body.page.totalElements).toBeGreaterThanOrEqual(
          byDesigner.body.page.totalElements,
        );
      });

      it("refuses a designer and a pilot with 403", async () => {
        for (const [id, role] of [
          [designerId, "DESIGNER"],
          [pilotId, "PILOT"],
        ] as const) {
          const { response, body } = await adminList("", id, role);
          expect(response.status).toBe(403);
          expect(body.status).toBe("FORBIDDEN");
          // Nothing of the listing leaks to a rejected caller.
          expect(body.content).toBeUndefined();
        }
      });
    });

    describe("POST /api/v1/missions/{id}/hide and /unhide", () => {
      /** The ids the open feed currently shows for one keyword. */
      async function feedIdsFor(keyword: string): Promise<number[]> {
        const response = await feedRoute(
          getRequest(
            `http://localhost/api/v1/missions?keyword=${encodeURIComponent(keyword)}`,
            pilotId,
            "PILOT",
          ),
          listContext,
        );
        return (await response.json()).map((m: { id: number }) => m.id);
      }

      it("walks a mission out of the live marketplace and back, auditing each direction", async () => {
        const keyword = `feedable ${tag}`;
        const target = await moderatedMission("feedable");
        // Warm the list cache with the mission present, so the assertions below
        // are about the write path's eviction rather than a cold cache.
        expect(await feedIdsFor(keyword)).toEqual([target.id]);

        const hidden = await hideRoute(
          postRequest(`http://localhost/api/v1/missions/${target.id}/hide`, adminId, "ADMIN"),
          idContext(target.id),
        );
        const hiddenBody = await hidden.json();

        // 200 with the updated mission, not 204: hiding is not deleting, and
        // the admin table re-renders the row from this body.
        expect(hidden.status).toBe(200);
        expect(hiddenBody).toMatchObject({ id: target.id, moderation: "HIDDEN" });
        // The lifecycle status is untouched — moderation is the other axis.
        expect(hiddenBody.status).toBe("PUBLISHED");
        expect((await missionRow(target.id)).moderation).toBe("HIDDEN");
        expect(await feedIdsFor(keyword)).toEqual([]);

        const hides = (await auditRowsFor(target.id)).filter(
          (entry) => entry.action === "MISSION_HIDDEN",
        );
        expect(hides).toHaveLength(1);
        expect(hides[0]).toMatchObject({
          // The acting admin off the verified headers, never the owner.
          actorId: adminId,
          actorRole: "ADMIN",
          targetType: "MISSION",
          details: `"Moderated feedable ${tag}"`,
        });
        // Moderation is silent: nobody is notified, unlike a cancellation.
        expect(await notificationsFor(designerId, target.id)).toEqual([]);

        const unhidden = await unhideRoute(
          postRequest(`http://localhost/api/v1/missions/${target.id}/unhide`, adminId, "ADMIN"),
          idContext(target.id),
        );
        expect(unhidden.status).toBe(200);
        expect((await unhidden.json()).moderation).toBe("VISIBLE");
        expect((await missionRow(target.id)).moderation).toBe("VISIBLE");
        expect(await feedIdsFor(keyword)).toEqual([target.id]);
        expect(
          (await auditRowsFor(target.id)).filter((entry) => entry.action === "MISSION_UNHIDDEN"),
        ).toHaveLength(1);
      });

      it("409s on a transition the mission is not in the `from` state for, and writes nothing", async () => {
        const target = await moderatedMission("conflicted");

        // Unhiding a VISIBLE mission: the state machine's `from` guard, and
        // deliberately *not* the idempotent no-op `users/{id}/suspend` is.
        const early = await unhideRoute(
          postRequest(`http://localhost/api/v1/missions/${target.id}/unhide`, adminId, "ADMIN"),
          idContext(target.id),
        );
        expect(early.status).toBe(409);
        // The message names the mission's *current* moderation and the
        // transition's target, so a redundant unhide reads "VISIBLE to
        // VISIBLE" — `"Mission %d cannot go from %s to %s"` verbatim, and the
        // Angular client surfaces this text as-is.
        expect((await early.json()).message).toBe(
          `Mission ${target.id} cannot go from VISIBLE to VISIBLE`,
        );

        await hideRoute(
          postRequest(`http://localhost/api/v1/missions/${target.id}/hide`, adminId, "ADMIN"),
          idContext(target.id),
        );
        const twice = await hideRoute(
          postRequest(`http://localhost/api/v1/missions/${target.id}/hide`, adminId, "ADMIN"),
          idContext(target.id),
        );
        expect(twice.status).toBe(409);
        expect((await twice.json()).message).toBe(
          `Mission ${target.id} cannot go from HIDDEN to HIDDEN`,
        );

        // One button press, one audit row — the rejected second one leaves none.
        expect(
          (await auditRowsFor(target.id)).filter((entry) => entry.action === "MISSION_HIDDEN"),
        ).toHaveLength(1);
        expect((await missionRow(target.id)).moderation).toBe("HIDDEN");
      });

      it("404s an unknown mission and 403s everyone but an admin — the owner included", async () => {
        const target = await moderatedMission("not-yours");

        expect(
          (
            await hideRoute(
              postRequest("http://localhost/api/v1/missions/999999999/hide", adminId, "ADMIN"),
              idContext(999999999),
            )
          ).status,
        ).toBe(404);

        // Unlike `/cancel`, ownership grants nothing here: moderating one's own
        // mission is not a designer's act at all.
        for (const [id, role] of [
          [designerId, "DESIGNER"],
          [pilotId, "PILOT"],
        ] as const) {
          const response = await hideRoute(
            postRequest(`http://localhost/api/v1/missions/${target.id}/hide`, id, role),
            idContext(target.id),
          );
          expect(response.status).toBe(403);
        }
        expect((await missionRow(target.id)).moderation).toBe("VISIBLE");
        expect(
          (await auditRowsFor(target.id)).filter((entry) => entry.action === "MISSION_HIDDEN"),
        ).toEqual([]);
      });
    });

    describe("POST /api/v1/missions/{id}/remove", () => {
      it("hard-deletes the mission with everything hanging off it, and leaves only the audit row", async () => {
        const target = await moderatedMission("doomed");
        // Everything V15 made cascade: a bid, the notification that bid's
        // rejection raises, and a rating against the mission.
        const bidId = await placeBid(target.id, pilotId, 700);
        await getDb().insert(notification).values({
          userId: pilotId,
          type: "BID_REJECTED",
          title: "Bid rejected",
          message: `Fixture notification ${tag}`,
          missionId: target.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await getDb().insert(rating).values({
          missionId: target.id,
          raterId: pilotId,
          rateeId: designerId,
          score: 4,
          createdAt: new Date(),
        });

        const response = await removeRoute(
          postRequest(`http://localhost/api/v1/missions/${target.id}/remove`, adminId, "ADMIN"),
          idContext(target.id),
        );

        // 204 with no body: the mission no longer exists to be returned — the
        // one moderation endpoint that answers no `MissionResponse`.
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");

        expect(await getDb().select().from(mission).where(eq(mission.id, target.id))).toEqual([]);
        expect(await getDb().select().from(bid).where(eq(bid.id, bidId))).toEqual([]);
        expect(
          await getDb().select().from(notification).where(eq(notification.missionId, target.id)),
        ).toEqual([]);
        expect(
          await getDb().select().from(rating).where(eq(rating.missionId, target.id)),
        ).toEqual([]);

        // And the reason `audit_log`'s target is a (type, id) pair rather than
        // a foreign key: for a hard delete, this row is the only record there
        // will ever be, so it has to outlive the row it describes.
        const removals = (await auditRowsFor(target.id)).filter(
          (entry) => entry.action === "MISSION_REMOVED",
        );
        expect(removals).toHaveLength(1);
        expect(removals[0]).toMatchObject({
          actorId: adminId,
          actorRole: "ADMIN",
          targetType: "MISSION",
          // Built from the mission loaded *before* the delete.
          details: `"Moderated doomed ${tag}"`,
        });

        // Gone from both listings, and a second removal is a 404.
        const { body } = await adminList(`?q=${encodeURIComponent(`moderated doomed ${tag}`)}`);
        expect(body.content).toEqual([]);
        const second = await removeRoute(
          postRequest(`http://localhost/api/v1/missions/${target.id}/remove`, adminId, "ADMIN"),
          idContext(target.id),
        );
        expect(second.status).toBe(404);
      });

      it("removes a mission in any state, without an ownership or status guard", async () => {
        // An admin's removal is not the owner's `DELETE /missions/{id}`: there
        // is no `PUBLISHED`-only rule and no ownership check, so a cancelled
        // mission belonging to someone else goes just the same.
        const target = await createMission(otherDesignerId, {
          name: `Moderated cancelled ${tag}`,
        });
        await getDb().update(mission).set({ status: "CANCELLED" }).where(eq(mission.id, target.id));

        const response = await removeRoute(
          postRequest(`http://localhost/api/v1/missions/${target.id}/remove`, adminId, "ADMIN"),
          idContext(target.id),
        );

        expect(response.status).toBe(204);
        expect(await getDb().select().from(mission).where(eq(mission.id, target.id))).toEqual([]);
      });

      it("refuses a pilot and the owning designer with 403, keeping the mission", async () => {
        const target = await moderatedMission("survivor");

        for (const [id, role] of [
          [pilotId, "PILOT"],
          [designerId, "DESIGNER"],
        ] as const) {
          const response = await removeRoute(
            postRequest(`http://localhost/api/v1/missions/${target.id}/remove`, id, role),
            idContext(target.id),
          );
          expect(response.status).toBe(403);
        }
        expect(await getDb().select().from(mission).where(eq(mission.id, target.id))).toHaveLength(
          1,
        );
        expect(
          (await auditRowsFor(target.id)).filter((entry) => entry.action === "MISSION_REMOVED"),
        ).toEqual([]);
      });
    });
  });
});

describe.skipIf(hasDb)("mission routes (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
