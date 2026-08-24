import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import type { UserRole } from "@/db/schema";
import type { Rating } from "@/features/ratings/rating.types";

/**
 * Route-level suite for every `RatingController` endpoint:
 * `POST|GET /api/v1/ratings/mission/{missionId}` and
 * `GET /api/v1/ratings/user/{userId}`.
 *
 * Shaped like `src/app/api/v1/bids/routes.test.ts`: the rating service module
 * is mocked and the exported handlers are called directly, so every assertion
 * here is about what the *web layer* contributes — the absence of a role gate,
 * the request validation, the status codes, and the `RatingResponse` /
 * `UserRatingsResponse` shapes the mapper produces. The backend has no
 * `RatingControllerTest` to mirror case-for-case (its rating test is the
 * Mockito `RatingServiceTest`, mirrored in
 * `src/features/ratings/rating.service.test.ts`), so the cases below are
 * derived from `RatingController`'s annotations plus the service errors it
 * lets through.
 *
 * The rules that are *not* the web layer's are asserted only through those
 * errors, since mapping them onto status codes is exactly the route layer's
 * job: a mission that does not exist reads as `MissionNotFoundError` -> 404,
 * one that has not been delivered yet as `RatingNotYetAllowedError` -> 409, a
 * second rating from the same person as `AlreadyRatedError` -> 409, and an
 * outsider as `NotMissionParticipantError` -> 403. Their real behavior is
 * pinned one layer down in `rating.service.test.ts`.
 *
 * The single most important thing this file pins is a *negative*: unlike every
 * other controller in the port, none of these three endpoints carries a role
 * gate — both sides of a mission rate each other, so `hasRole(...)` would lock
 * out half of every exchange. The cases below therefore drive the POST as a
 * designer *and* as a pilot and expect both to reach the service.
 *
 * All three paths are authenticated-only — none are in `src/middleware.ts`'s
 * `PUBLIC_PATHS` — so the anonymous cases call `middleware()` directly, the
 * layer that actually rejects them in the deployed app (the precedent set by
 * `src/app/api/v1/notifications/routes.test.ts`), while the authenticated
 * cases pass the `x-user-id`/`x-user-role` headers `middleware.ts` would have
 * attached from the verified token's claims.
 *
 * SOURCE: drone-missions-backend/.../web/controller/rating/RatingController.java
 */

// Every function the handlers call is stubbed on the service module — the one
// layer they talk to. `summaryFor` is among them: the aggregate itself lives in
// `rating.queries.ts`, but the service re-exports it so the profile route names
// a single layer (see that route's doc comment), and stubbing it here is what
// keeps these route tests off the database. Everything else on the module comes
// off `importOriginal`, including the three error classes.
const createMock = vi.fn();
const forMissionMock = vi.fn();
const receivedByMock = vi.fn();
const summaryForMock = vi.fn();
vi.mock("@/features/ratings/rating.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/ratings/rating.service")>();
  return {
    ...actual,
    create: (...args: unknown[]) => createMock(...args),
    forMission: (...args: unknown[]) => forMissionMock(...args),
    receivedBy: (...args: unknown[]) => receivedByMock(...args),
    summaryFor: (...args: unknown[]) => summaryForMock(...args),
  };
});

// The `vi.mock` call is hoisted by Vitest, so this already resolves against the
// mocked module (the three error classes come off `importOriginal`, so they are
// the real ones the handlers will see); `RATING_SUMMARY_NONE` comes straight
// off the unmocked query module.
import {
  AlreadyRatedError,
  NotMissionParticipantError,
  RatingNotYetAllowedError,
} from "@/features/ratings/rating.service";
import { RATING_SUMMARY_NONE } from "@/features/ratings/rating.queries";
import { MissionNotFoundError } from "@/features/missions/mission.service";
import { GET as forMissionRoute, POST as rateRoute } from "@/app/api/v1/ratings/mission/[missionId]/route";
import { GET as forUserRoute } from "@/app/api/v1/ratings/user/[userId]/route";

const DESIGNER_ID = 7;
const PILOT_ID = 42;
const OUTSIDER_ID = 99;
const MISSION_ID = 1;

/** The context Next.js hands `ratings/mission/[missionId]` for the given segment. */
function missionContext(missionId: string) {
  return { params: Promise.resolve({ missionId }) };
}

/** The context Next.js hands `ratings/user/[userId]` for the given segment. */
function userContext(userId: string) {
  return { params: Promise.resolve({ userId }) };
}

/** The headers `src/middleware.ts` attaches from a verified token's claims. */
function authHeaders(userId: number, role: UserRole): Record<string, string> {
  return { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role };
}

function getRequest(url: string, userId = DESIGNER_ID, role: UserRole = "DESIGNER"): Request {
  return new Request(url, { headers: authHeaders(userId, role) });
}

function jsonRequest(
  url: string,
  body: unknown,
  userId = DESIGNER_ID,
  role: UserRole = "DESIGNER",
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(userId, role) },
    body: JSON.stringify(body),
  });
}

/** A rating as `rating.queries.ts` hands it out: `mission` and `rater` resolved. */
function fakeRating(overrides: Partial<Rating> = {}): Rating {
  return {
    id: 11,
    missionId: MISSION_ID,
    raterId: DESIGNER_ID,
    rateeId: PILOT_ID,
    score: 5,
    comment: "Clean pass, delivered a day early",
    createdAt: new Date("2026-04-08T09:00:00Z"),
    mission: { id: MISSION_ID, name: "Orchard survey" },
    rater: { id: DESIGNER_ID, username: "dana" },
    ...overrides,
  };
}

/** The pilot's rating of the designer — the other direction on the same mission. */
function fakeReturnRating(overrides: Partial<Rating> = {}): Rating {
  return fakeRating({
    id: 12,
    raterId: PILOT_ID,
    rateeId: DESIGNER_ID,
    score: 4,
    comment: null,
    createdAt: new Date("2026-04-09T09:00:00Z"),
    rater: { id: PILOT_ID, username: "pia" },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ratings/mission/{missionId}", () => {
  it("saves the rating and answers 200 (not 201) with the RatingResponse body", async () => {
    createMock.mockResolvedValue(fakeRating());

    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", {
        score: 5,
        comment: "Clean pass, delivered a day early",
      }),
      missionContext("1"),
    );
    const body = await response.json();

    // `ResponseEntity.ok(...)`, and no Location header — the source builds no
    // `201 Created` here, unlike `POST /api/v1/missions`.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(body).toEqual({
      id: 11,
      missionId: MISSION_ID,
      missionName: "Orchard survey",
      raterId: DESIGNER_ID,
      raterName: "dana",
      rateeId: PILOT_ID,
      score: 5,
      comment: "Clean pass, delivered a day early",
      createdAt: "2026-04-08T09:00:00.000Z",
    });
    // The two relations the mapper flattens must not reach the wire.
    expect(body).not.toHaveProperty("mission");
    expect(body).not.toHaveProperty("rater");
  });

  it("hands the service the mission id, the rater from the token, and the two request fields", async () => {
    createMock.mockResolvedValue(fakeRating());

    await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1?userId=99", {
        score: 5,
        comment: "Clean pass, delivered a day early",
      }),
      missionContext("1"),
    );

    // Never the query string: the rating is attributed to the verified caller.
    expect(createMock).toHaveBeenCalledWith(1, DESIGNER_ID, 5, "Clean pass, delivered a day early");
  });

  it("never lets the caller name the ratee — it is derived from the mission", async () => {
    createMock.mockResolvedValue(fakeRating());

    await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", {
        score: 5,
        rateeId: OUTSIDER_ID,
        raterId: OUTSIDER_ID,
      }),
      missionContext("1"),
    );

    // Four arguments, and neither smuggled id is among them: `counterpartOf`
    // resolves the ratee from the mission row.
    expect(createMock).toHaveBeenCalledWith(1, DESIGNER_ID, 5, undefined);
  });

  it("passes an omitted comment through as undefined", async () => {
    createMock.mockResolvedValue(fakeRating({ comment: null }));

    await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 3 }),
      missionContext("1"),
    );

    expect(createMock).toHaveBeenCalledWith(1, DESIGNER_ID, 3, undefined);
  });

  it("normalises a blank comment to undefined, so 'no comment' has one representation", async () => {
    createMock.mockResolvedValue(fakeRating({ comment: null }));

    await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 3, comment: "   " }),
      missionContext("1"),
    );

    expect(createMock).toHaveBeenCalledWith(1, DESIGNER_ID, 3, undefined);
  });

  it("trims an accepted comment", async () => {
    createMock.mockResolvedValue(fakeRating());

    await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 3, comment: "  neat  " }),
      missionContext("1"),
    );

    expect(createMock).toHaveBeenCalledWith(1, DESIGNER_ID, 3, "neat");
  });

  it("serializes a missing comment as an explicit null, as the un-annotated record does", async () => {
    createMock.mockResolvedValue(fakeRating({ comment: null }));

    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 3 }),
      missionContext("1"),
    );
    const body = await response.json();

    // No `@JsonInclude(NON_NULL)` on `RatingResponse`, so the key is present.
    expect(Object.keys(body)).toContain("comment");
    expect(body.comment).toBeNull();
  });

  it("lets a pilot rate too — there is no role gate, both sides rate", async () => {
    createMock.mockResolvedValue(fakeReturnRating());

    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 4 }, PILOT_ID, "PILOT"),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ raterId: PILOT_ID, raterName: "pia", rateeId: DESIGNER_ID });
    expect(createMock).toHaveBeenCalledWith(1, PILOT_ID, 4, undefined);
  });

  it("does not stop an admin at the route either — @PreAuthorize is only isAuthenticated()", async () => {
    // Whether an admin may rate is a *participation* question, not a role one,
    // so the route must let the call through and leave the refusal to the
    // service (the 403 case below). Pinning this keeps a well-meaning
    // `requireRole()` from being added later.
    createMock.mockRejectedValue(new NotMissionParticipantError(MISSION_ID));

    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 5 }, 1, "ADMIN"),
      missionContext("1"),
    );

    expect(createMock).toHaveBeenCalledWith(1, 1, 5, undefined);
    expect(response.status).toBe(403);
  });

  it("rejects a missing score with 400 and a field error (@NotNull)", async () => {
    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { comment: "nice" }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toBe("Data validation failed");
    expect(body.data).toMatchObject({ score: "must not be null" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a score of 0 with 400 (@Min(1))", async () => {
    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 0 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ score: "must be greater than or equal to 1" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a score of 6 with 400 (@Max(5))", async () => {
    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 6 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ score: "must be less than or equal to 5" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a fractional score with 400 rather than truncating it", async () => {
    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 3.5 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ score: "must be an integer" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("accepts both ends of the star range", async () => {
    createMock.mockResolvedValue(fakeRating({ score: 1 }));

    for (const score of [1, 5]) {
      const response = await rateRoute(
        jsonRequest("http://localhost/api/v1/ratings/mission/1", { score }),
        missionContext("1"),
      );

      expect(response.status).toBe(200);
    }
  });

  it("rejects a comment longer than 500 characters with 400 (@Size(max = 500))", async () => {
    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", {
        score: 5,
        comment: "x".repeat(501),
      }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ comment: "size must be between 0 and 500" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("accepts a comment of exactly 500 characters", async () => {
    createMock.mockResolvedValue(fakeRating());

    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", {
        score: 5,
        comment: "x".repeat(500),
      }),
      missionContext("1"),
    );

    expect(response.status).toBe(200);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const response = await rateRoute(
      new Request("http://localhost/api/v1/ratings/mission/1", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(DESIGNER_ID, "DESIGNER") },
        body: "{ not json",
      }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toBe("Malformed or unreadable request body");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric mission id with 400, mirroring the @PathVariable Long conversion failure", async () => {
    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/abc", { score: 5 }),
      missionContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ missionId: "must be a number" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a mission that does not exist", async () => {
    createMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/9", { score: 5 }),
      missionContext("9"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ status: "NOT_FOUND", message: "Mission 9 not found" });
  });

  it("answers 409 while the mission has not been completed, naming the status it is in", async () => {
    createMock.mockRejectedValue(new RatingNotYetAllowedError(MISSION_ID, "IN_PROGRESS"));

    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 5 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      status: "CONFLICT",
      // The Angular toast prints this verbatim, so the status has to be in it.
      message: "Mission 1 is IN_PROGRESS — it can only be rated once completed",
    });
  });

  it("answers 409 on a second rating from the same person — ratings are final", async () => {
    createMock.mockRejectedValue(new AlreadyRatedError(MISSION_ID));

    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 1 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      status: "CONFLICT",
      message: "You have already rated mission 1",
    });
  });

  it("answers 403 for someone who took no part in the mission", async () => {
    createMock.mockRejectedValue(new NotMissionParticipantError(MISSION_ID));

    const response = await rateRoute(
      jsonRequest("http://localhost/api/v1/ratings/mission/1", { score: 5 }, OUTSIDER_ID, "PILOT"),
      missionContext("1"),
    );
    const body = await response.json();

    // A 403 rather than the 404-masking the bid routes use: the caller already
    // named a mission id that exists, and nothing here is secret from them.
    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      status: "FORBIDDEN",
      message: "You did not take part in mission 1, so you cannot rate it",
    });
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/ratings/mission/1"), { method: "POST" }),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/ratings/mission/{missionId}", () => {
  it("returns both ratings on the mission, newest first, as a bare RatingResponse array", async () => {
    forMissionMock.mockResolvedValue([fakeReturnRating(), fakeRating()]);

    const response = await forMissionRoute(
      getRequest("http://localhost/api/v1/ratings/mission/1"),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);
    // The order the query established (`created_at DESC`) survives the mapping.
    expect(body.map((entry: { id: number }) => entry.id)).toEqual([12, 11]);
    expect(body[0]).toMatchObject({
      id: 12,
      missionId: MISSION_ID,
      missionName: "Orchard survey",
      raterId: PILOT_ID,
      raterName: "pia",
      rateeId: DESIGNER_ID,
      score: 4,
      comment: null,
    });
    expect(forMissionMock).toHaveBeenCalledWith(1, DESIGNER_ID);
  });

  it("returns an empty array for a completed mission neither side has rated yet", async () => {
    forMissionMock.mockResolvedValue([]);

    const response = await forMissionRoute(
      getRequest("http://localhost/api/v1/ratings/mission/1", PILOT_ID, "PILOT"),
      missionContext("1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it("takes the caller id from the verified token headers, never from the query string", async () => {
    forMissionMock.mockResolvedValue([]);

    await forMissionRoute(
      getRequest("http://localhost/api/v1/ratings/mission/1?userId=99", PILOT_ID, "PILOT"),
      missionContext("1"),
    );

    expect(forMissionMock).toHaveBeenCalledWith(1, PILOT_ID);
  });

  it("answers 403 — not an empty list — for a non-participant", async () => {
    forMissionMock.mockRejectedValue(new NotMissionParticipantError(MISSION_ID));

    const response = await forMissionRoute(
      getRequest("http://localhost/api/v1/ratings/mission/1", OUTSIDER_ID, "PILOT"),
      missionContext("1"),
    );
    const body = await response.json();

    // "There are no ratings here" and "you may not see them" are different
    // answers, and the source gives the second one.
    expect(response.status).toBe(403);
    expect(body.message).toBe("You did not take part in mission 1, so you cannot rate it");
  });

  it("answers 404 for a mission that does not exist", async () => {
    forMissionMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await forMissionRoute(
      getRequest("http://localhost/api/v1/ratings/mission/9"),
      missionContext("9"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a non-numeric mission id with 400", async () => {
    const response = await forMissionRoute(
      getRequest("http://localhost/api/v1/ratings/mission/abc"),
      missionContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ missionId: "must be a number" });
    expect(forMissionMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/ratings/mission/1")),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/ratings/user/{userId}", () => {
  it("returns the average, the count and the reviews in one payload", async () => {
    summaryForMock.mockResolvedValue({ average: 4.5, count: 2 });
    receivedByMock.mockResolvedValue([fakeRating({ rateeId: PILOT_ID }), fakeReturnRating()]);

    const response = await forUserRoute(
      getRequest("http://localhost/api/v1/ratings/user/42"),
      userContext("42"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["average", "count", "ratings"]);
    expect(body.average).toBe(4.5);
    expect(body.count).toBe(2);
    expect(body.ratings).toHaveLength(2);
    expect(body.ratings[0]).toMatchObject({
      id: 11,
      missionName: "Orchard survey",
      raterName: "dana",
      score: 5,
    });
    // Both halves are addressed by the path variable, not by the caller.
    expect(summaryForMock).toHaveBeenCalledWith(42);
    expect(receivedByMock).toHaveBeenCalledWith(42);
  });

  it("takes the count from the aggregate, not from the list it ships alongside", async () => {
    // The two come from different queries in the source, and only the
    // aggregate is authoritative — `receivedBy` could be paged later without
    // the headline number moving.
    summaryForMock.mockResolvedValue({ average: 4.5, count: 8 });
    receivedByMock.mockResolvedValue([fakeRating()]);

    const response = await forUserRoute(
      getRequest("http://localhost/api/v1/ratings/user/42"),
      userContext("42"),
    );
    const body = await response.json();

    expect(body.count).toBe(8);
    expect(body.ratings).toHaveLength(1);
  });

  it("answers 200 with a zeroed summary for an unrated or unknown user, never 404", async () => {
    summaryForMock.mockResolvedValue(RATING_SUMMARY_NONE);
    receivedByMock.mockResolvedValue([]);

    const response = await forUserRoute(
      getRequest("http://localhost/api/v1/ratings/user/12345"),
      userContext("12345"),
    );
    const body = await response.json();

    // No user lookup happens at all in the source, so a profile with no
    // reviews and an id that never existed are the same answer.
    expect(response.status).toBe(200);
    expect(body).toEqual({ average: 0, count: 0, ratings: [] });
  });

  it("is not self-only: any authenticated role may read anyone's reputation", async () => {
    summaryForMock.mockResolvedValue({ average: 5, count: 1 });
    receivedByMock.mockResolvedValue([fakeRating()]);

    const response = await forUserRoute(
      // A pilot reading a designer's profile — the endpoint takes no principal.
      getRequest("http://localhost/api/v1/ratings/user/7", PILOT_ID, "PILOT"),
      userContext("7"),
    );

    expect(response.status).toBe(200);
    expect(summaryForMock).toHaveBeenCalledWith(7);
  });

  it("rejects a non-numeric user id with 400 and reads nothing", async () => {
    const response = await forUserRoute(
      getRequest("http://localhost/api/v1/ratings/user/abc"),
      userContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ userId: "must be a number" });
    expect(summaryForMock).not.toHaveBeenCalled();
    expect(receivedByMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/ratings/user/42")),
    );

    expect(response.status).toBe(401);
  });
});
