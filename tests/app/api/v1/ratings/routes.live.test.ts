import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, mission, rating, users } from "@/db/schema";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import { getMissionDao } from "@/features/missions/server/mission.cache";
import type { UserRole } from "@/db/schema";
import { GET as forMissionRoute, POST as rateRoute } from "@/app/api/v1/ratings/mission/[missionId]/route";
import { GET as forUserRoute } from "@/app/api/v1/ratings/user/[userId]/route";

/**
 * Route-level **integration** suite for the rating endpoints: the real
 * handlers over the real `RatingService`, the real caching mission DAO, the
 * real audit service and a real Postgres, with nothing mocked.
 *
 * This is the live-DB counterpart of `routes.test.ts`, which mocks
 * `RatingService` and therefore proves only what the web layer contributes
 * (the absent role gate, the validation, the status codes). Two things live
 * *under* that mock boundary and cannot be proven there:
 *
 * - **the profile endpoint's composition.** `GET /api/v1/ratings/user/{id}` is
 *   the one handler in this controller that assembles its response out of two
 *   independent reads — the `summaryFor` aggregate and the `receivedBy` row
 *   list. Against mocks the two agree by construction; against real rows the
 *   average has to actually be the mean of the scores the same call ships, and
 *   the list has to span every mission the user was rated on, not just one.
 *   `rating.service.live.test.ts` exercises the two halves separately and
 *   never composes them, because composing them is the route's job.
 * - **the round trip through the endpoints as a pair.** The rating a
 *   participant reads back out of `GET .../mission/{id}` is the one the other
 *   participant POSTed, joined names and all — the flattening
 *   `RatingMapper` does over relations that only exist once real SQL has
 *   resolved them.
 *
 * The refusals are re-checked here for the reason the bid suite gives: a 409
 * off a real `existsByMissionAndRater` read (rather than a stubbed rejection)
 * is what proves the caller never reaches the
 * `rating_mission_rater_unique` backstop and gets a 500 instead.
 *
 * It lives in a separate file rather than in `routes.test.ts` because that
 * file's `vi.mock` of the rating service is module-scoped: a live-DB block
 * inside it would still be talking to the mocks. Same split as
 * `src/app/api/v1/bids/routes.live.test.ts`.
 *
 * Fixtures are inserted directly rather than driven through the register /
 * mission / bid / accept / complete endpoints the way the bid suite builds
 * its world: a rating needs nothing of that history beyond a COMPLETED
 * mission with both ids on it, which is precisely the shape
 * `rating.service.live.test.ts` sets up, so its harness is reused.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../web/controller/rating/RatingController.java
 * - drone-missions-backend/.../business/service/rating/RatingService.java
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("rating routes (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();

  const insertedUserIds: number[] = [];
  const insertedMissionIds: number[] = [];

  let designerId: number;
  let pilotId: number;
  /** Neither side of any mission here — the participant gate's negative case. */
  let outsiderId: number;

  /** COMPLETED, and the mission both sides rate. */
  let deliveredId: number;
  /** COMPLETED too, so the pilot's profile spans more than one mission. */
  let secondJobId: number;
  /** IN_PROGRESS — nothing to rate yet. */
  let runningId: number;

  const deliveredName = `Delivered survey ${runId}`;
  const secondJobName = `Second job ${runId}`;

  /** An id past every identity value this database has issued. */
  const UNKNOWN_MISSION_ID = 999_999_999;

  function missionContext(missionId: number | string) {
    return { params: Promise.resolve({ missionId: String(missionId) }) };
  }

  function userContext(userId: number | string) {
    return { params: Promise.resolve({ userId: String(userId) }) };
  }

  /** The headers `src/middleware.ts` attaches from a verified token's claims. */
  function authHeaders(userId: number, role: UserRole): Record<string, string> {
    return { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role };
  }

  function getRequest(url: string, userId: number, role: UserRole): Request {
    return new Request(url, { headers: authHeaders(userId, role) });
  }

  function jsonRequest(url: string, body: unknown, userId: number, role: UserRole): Request {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(userId, role) },
      body: JSON.stringify(body),
    });
  }

  /** POSTs a rating as the given caller and returns the raw response. */
  async function rate(
    missionId: number,
    caller: { id: number; role: UserRole },
    body: { score?: unknown; comment?: unknown },
  ): Promise<Response> {
    return rateRoute(
      jsonRequest(
        `http://localhost/api/v1/ratings/mission/${missionId}`,
        body,
        caller.id,
        caller.role,
      ),
      missionContext(missionId),
    );
  }

  async function insertUser(label: string, role: UserRole): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `rating-route-${label}-${runId}`,
        email: `rating-route-${runId}-${label}@example.com`,
        // A literal, obviously-not-a-hash placeholder: nothing in this suite
        // authenticates — the handlers read the headers `middleware.ts` would
        // have attached — and the column is only NOT NULL.
        passwordHash: "not-a-real-hash",
        role,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id });
    insertedUserIds.push(row.id);
    return row.id;
  }

  async function insertMission(values: {
    name: string;
    status: "COMPLETED" | "IN_PROGRESS";
  }): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(mission)
      .values({
        name: values.name,
        description: `rating-route-${runId}`,
        status: values.status,
        moderation: "VISIBLE",
        userId: designerId,
        awardedPilotId: pilotId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: mission.id });
    insertedMissionIds.push(row.id);
    return row.id;
  }

  /** Every `RATING_CREATED` entry this actor produced. */
  async function ratingAuditsFor(actorId: number) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, actorId), eq(auditLog.action, "RATING_CREATED")));
  }

  beforeAll(async () => {
    designerId = await insertUser("designer", "DESIGNER");
    pilotId = await insertUser("pilot", "PILOT");
    outsiderId = await insertUser("outsider", "PILOT");

    deliveredId = await insertMission({ name: deliveredName, status: "COMPLETED" });
    secondJobId = await insertMission({ name: secondJobName, status: "COMPLETED" });
    runningId = await insertMission({ name: `Running job ${runId}`, status: "IN_PROGRESS" });
  });

  afterAll(async () => {
    if (insertedUserIds.length > 0) {
      // Audit rows first: `fk_audit_log_actor` does not cascade.
      await getDb().delete(auditLog).where(inArray(auditLog.actorId, insertedUserIds));
    }
    if (insertedMissionIds.length > 0) {
      // `fk_rating_mission ON DELETE CASCADE` would take the ratings anyway;
      // they go explicitly so nothing depends on the cascade staying.
      await getDb().delete(rating).where(inArray(rating.missionId, insertedMissionIds));
      await getDb().delete(mission).where(inArray(mission.id, insertedMissionIds));
      // The handlers read missions through the cached DAO; drop what they
      // cached so a later suite in the same process never sees a deleted row.
      for (const id of insertedMissionIds) {
        getMissionDao().invalidate(id);
      }
    }
    if (insertedUserIds.length > 0) {
      // `fk_rating_rater`/`fk_rating_ratee` and `fk_mission_user` do not
      // cascade, so both of the above had to go first.
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  describe("POST /api/v1/ratings/mission/{missionId}", () => {
    it("persists the designer's rating, answers 200 with the joined names, and audits it", async () => {
      const response = await rate(
        deliveredId,
        { id: designerId, role: "DESIGNER" },
        { score: 5, comment: "  Clean pass, delivered a day early  " },
      );
      const body = await response.json();

      // `ResponseEntity.ok(...)`, and no Location header — the source builds no
      // `201 Created` here, unlike `POST /api/v1/missions`.
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(body).toMatchObject({
        missionId: deliveredId,
        // Resolved server-side off the joins, never sent by the client.
        missionName: deliveredName,
        raterId: designerId,
        // Derived from the mission row by `counterpartOf`, not from the body.
        rateeId: pilotId,
        score: 5,
        comment: "Clean pass, delivered a day early",
      });
      expect(body.raterName).toContain("rating-route-designer");

      const [row] = await getDb().select().from(rating).where(eq(rating.id, body.id));
      expect(row).toMatchObject({ missionId: deliveredId, raterId: designerId, rateeId: pilotId });
      // Stamped by the insert and never updated: a rating is written once.
      expect(row.createdAt).toBeInstanceOf(Date);

      const audits = await ratingAuditsFor(designerId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorId: designerId,
        // Derived, not constant: both sides may rate, so the entry has to say
        // which side this one was.
        actorRole: "DESIGNER",
        action: "RATING_CREATED",
        targetType: "RATING",
        targetId: body.id,
        details: `5/5 on "${deliveredName}"`,
      });
    });

    it("lets the awarded pilot rate the designer on the same mission — no role gate", async () => {
      const response = await rate(deliveredId, { id: pilotId, role: "PILOT" }, { score: 4 });
      const body = await response.json();

      // The negative this controller exists to prove: `hasRole(...)` would lock
      // out half of every exchange, so there is no role gate on either verb.
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        missionId: deliveredId,
        raterId: pilotId,
        rateeId: designerId,
        score: 4,
        // No `@JsonInclude(NON_NULL)` on the record, so the key is present.
        comment: null,
      });

      const [entry] = await ratingAuditsFor(pilotId);
      expect(entry).toMatchObject({ actorRole: "PILOT", details: `4/5 on "${deliveredName}"` });
    });

    it("answers 409 on a second rating from the same person, without reaching the unique index", async () => {
      const response = await rate(
        deliveredId,
        { id: designerId, role: "DESIGNER" },
        { score: 1, comment: "changed my mind" },
      );
      const body = await response.json();

      // A 409 the Angular toast can read, not the 500 a raw
      // `rating_mission_rater_unique` violation would produce: the caller is
      // stopped by `existsByMissionAndRater` before the insert is attempted.
      expect(response.status).toBe(409);
      expect(body).toMatchObject({
        status: "CONFLICT",
        message: `You have already rated mission ${deliveredId}`,
      });

      // Ratings are final: the first score stands and nothing was added.
      const rows = await getDb().select().from(rating).where(eq(rating.missionId, deliveredId));
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.raterId === designerId)?.score).toBe(5);
    });

    it("answers 409 while the mission has not been completed, naming the status it is in", async () => {
      const response = await rate(runningId, { id: designerId, role: "DESIGNER" }, { score: 5 });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toMatchObject({
        status: "CONFLICT",
        message: `Mission ${runningId} is IN_PROGRESS — it can only be rated once completed`,
      });
      await expect(
        getDb().select().from(rating).where(eq(rating.missionId, runningId)),
      ).resolves.toEqual([]);
    });

    it("answers 403 for someone who took no part in the mission, and writes nothing", async () => {
      const response = await rate(secondJobId, { id: outsiderId, role: "PILOT" }, { score: 5 });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toMatchObject({
        status: "FORBIDDEN",
        message: `You did not take part in mission ${secondJobId}, so you cannot rate it`,
      });
      await expect(ratingAuditsFor(outsiderId)).resolves.toEqual([]);
    });

    it("answers 404 for a mission that does not exist", async () => {
      const response = await rate(
        UNKNOWN_MISSION_ID,
        { id: designerId, role: "DESIGNER" },
        { score: 5 },
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toMatchObject({
        status: "NOT_FOUND",
        message: `Mission ${UNKNOWN_MISSION_ID} not found`,
      });
    });

    it("rejects an out-of-range score with 400 before the database is touched", async () => {
      const response = await rate(secondJobId, { id: designerId, role: "DESIGNER" }, { score: 9 });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.data).toMatchObject({ score: "must be less than or equal to 5" });
      await expect(
        getDb().select().from(rating).where(eq(rating.missionId, secondJobId)),
      ).resolves.toEqual([]);
    });
  });

  describe("GET /api/v1/ratings/mission/{missionId}", () => {
    it("hands a participant both ratings on the mission, newest first, with the names flattened", async () => {
      const response = await forMissionRoute(
        getRequest(
          `http://localhost/api/v1/ratings/mission/${deliveredId}`,
          designerId,
          "DESIGNER",
        ),
        missionContext(deliveredId),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      // At most two rows can exist here, one per side, by
      // `rating_mission_rater_unique`.
      expect(body).toHaveLength(2);
      // `created_at DESC` — asserted on the timestamps rather than on a fixed
      // id order, since the two writes can land in the same millisecond.
      const times = body.map((entry: { createdAt: string }) => Date.parse(entry.createdAt));
      expect(times[0]).toBeGreaterThanOrEqual(times[1]);

      const byRater = new Map<number, Record<string, unknown>>(
        body.map((entry: { raterId: number }) => [entry.raterId, entry]),
      );
      // What the read adds over the write: the *other* side's rating, shaped
      // by the same mapper.
      expect(byRater.get(pilotId)).toMatchObject({
        missionId: deliveredId,
        missionName: deliveredName,
        rateeId: designerId,
        score: 4,
        comment: null,
      });
      expect(byRater.get(pilotId)?.raterName).toContain("rating-route-pilot");
      expect(byRater.get(designerId)).toMatchObject({ rateeId: pilotId, score: 5 });
      // The two relations the mapper flattens must not reach the wire.
      expect(body[0]).not.toHaveProperty("mission");
      expect(body[0]).not.toHaveProperty("rater");
    });

    it("returns an empty array for a completed mission neither side has rated yet", async () => {
      const response = await forMissionRoute(
        getRequest(`http://localhost/api/v1/ratings/mission/${secondJobId}`, pilotId, "PILOT"),
        missionContext(secondJobId),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([]);
    });

    it("answers 403 — not an empty list — for a non-participant", async () => {
      const response = await forMissionRoute(
        getRequest(`http://localhost/api/v1/ratings/mission/${deliveredId}`, outsiderId, "PILOT"),
        missionContext(deliveredId),
      );
      const body = await response.json();

      // "There are no ratings here" and "you may not see them" are different
      // answers, and the source gives the second one.
      expect(response.status).toBe(403);
      expect(body.status).toBe("FORBIDDEN");
    });

    it("answers 404 for a mission that does not exist", async () => {
      const response = await forMissionRoute(
        getRequest(
          `http://localhost/api/v1/ratings/mission/${UNKNOWN_MISSION_ID}`,
          designerId,
          "DESIGNER",
        ),
        missionContext(UNKNOWN_MISSION_ID),
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/v1/ratings/user/{userId}", () => {
    it("composes the average and count over every mission the user was rated on", async () => {
      // A second completed job, so the profile spans more than one mission and
      // the average is genuinely an aggregate rather than a single score.
      const second = await rate(
        secondJobId,
        { id: designerId, role: "DESIGNER" },
        { score: 4, comment: "Solid work" },
      );
      expect(second.status).toBe(200);

      const response = await forUserRoute(
        getRequest(`http://localhost/api/v1/ratings/user/${pilotId}`, outsiderId, "PILOT"),
        userContext(pilotId),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(["average", "count", "ratings"]);
      // The mean of the two scores the same payload ships — the one fact that
      // only exists once the aggregate and the row list are composed.
      expect(body.average).toBe(4.5);
      expect(body.count).toBe(2);
      expect(body.ratings).toHaveLength(2);
      // Every review is one the pilot *received*; the one they wrote about the
      // designer on the same mission is not here.
      for (const entry of body.ratings as { rateeId: number; raterId: number }[]) {
        expect(entry.rateeId).toBe(pilotId);
        expect(entry.raterId).toBe(designerId);
      }
      // Spans both missions, each carrying its own name for the review card.
      expect(
        (body.ratings as { missionName: string }[]).map((entry) => entry.missionName).sort(),
      ).toEqual([deliveredName, secondJobName].sort());
    });

    it("is not self-only: any authenticated user may read anyone's reputation", async () => {
      // The designer's own reputation, read by the outsider — the endpoint
      // takes no principal at all.
      const response = await forUserRoute(
        getRequest(`http://localhost/api/v1/ratings/user/${designerId}`, outsiderId, "PILOT"),
        userContext(designerId),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ average: 4, count: 1 });
      expect(body.ratings).toHaveLength(1);
      expect(body.ratings[0]).toMatchObject({ raterId: pilotId, rateeId: designerId, score: 4 });
    });

    it("answers 200 with a zeroed summary for a user nobody has rated, never 404", async () => {
      const response = await forUserRoute(
        getRequest(`http://localhost/api/v1/ratings/user/${outsiderId}`, pilotId, "PILOT"),
        userContext(outsiderId),
      );

      // No user lookup happens at all in the source, so a profile with no
      // reviews and an id that never existed are the same answer.
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ average: 0, count: 0, ratings: [] });
    });
  });
});
