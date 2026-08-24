import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import type { Page } from "@/lib/api/paging";
import type { UserRole } from "@/db/schema";
import type { User } from "@/features/users/user.types";
import type { Mission } from "@/features/missions/mission.types";

/**
 * Route-level suite for the mission endpoints: `POST /api/v1/missions`,
 * `GET /api/v1/missions`, `GET /api/v1/missions/my-missions` and
 * `GET|PUT|DELETE /api/v1/missions/{id}` from phase 2, plus the phase-5
 * lifecycle trio `POST /api/v1/missions/{id}/{start,complete,cancel}` and the
 * pilot listing `GET /api/v1/missions/my-jobs`; from phase 7, the admin
 * moderation endpoints `GET /api/v1/missions/all` and
 * `POST /api/v1/missions/{id}/{hide,unhide,remove}`.
 *
 * Mirrors `MissionControllerTest`, which is a Mockito unit test of the
 * controller rather than a live-database one: `MissionService` and
 * `RatingService` are mocked (`summariesFor` -> `Map.of()`, `summaryFor` ->
 * `RatingSummary.NONE`) so the assertions are about what the *web layer*
 * does — the null-designer resilience of every response path
 * (`mission.user_id` is nullable by design; see V4), the status codes, and
 * the request validation. This suite mocks exactly the same two collaborators
 * and calls the exported route handlers directly, the way real traffic
 * reaches them after `src/middleware.ts` has verified the bearer token and
 * attached the `x-user-id`/`x-user-role` headers.
 *
 * That is deliberately *not* the live-DB shape of
 * `tests/app/api/v1/auth/routes.test.ts`: the behaviors under test here are the
 * controller's own, the service and DAO layers already have their own suites
 * (`mission.service.test.ts`, `mission.cache.test.ts`), and the end-to-end
 * path through a real database is covered by `e2e/missions.spec.ts`.
 *
 * The two rules that are *not* the web layer's — mission visibility (invisible
 * -> 404, never 403) and ownership (-> 403) — are asserted here only through
 * the errors the service raises, since mapping those to status codes is what
 * the route layer contributes.
 *
 * The 401 cases of the phase-7 admin endpoints go through `middleware()`
 * itself, the layer that actually rejects an anonymous caller in the deployed
 * app (none of these paths are in its `PUBLIC_PATHS`), following the precedent
 * of `tests/app/api/v1/users/routes.test.ts`. The 403 cases call the handlers
 * with a verified non-admin's headers, since `requireRole()` is what stands in
 * for `@PreAuthorize("hasRole('ADMIN')")`.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/controller/mission/MissionController.java
 * - test drone-missions-backend/.../web/controller/mission/MissionControllerTest.java
 */

const createMock = vi.fn();
const findOpenMock = vi.fn();
const findOwnedByMock = vi.fn();
const findAwardedToMock = vi.fn();
const findByIdMock = vi.fn();
const updateMock = vi.fn();
const deleteMissionMock = vi.fn();
const startMock = vi.fn();
const completeMock = vi.fn();
const cancelMock = vi.fn();
const searchAllMock = vi.fn();
const hideMock = vi.fn();
const unhideMock = vi.fn();
const removeMock = vi.fn();
vi.mock("@/features/missions/server/mission.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/missions/server/mission.service")>();
  return {
    ...actual,
    create: (...args: unknown[]) => createMock(...args),
    findOpen: (...args: unknown[]) => findOpenMock(...args),
    findOwnedBy: (...args: unknown[]) => findOwnedByMock(...args),
    findAwardedTo: (...args: unknown[]) => findAwardedToMock(...args),
    findById: (...args: unknown[]) => findByIdMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    deleteMission: (...args: unknown[]) => deleteMissionMock(...args),
    start: (...args: unknown[]) => startMock(...args),
    complete: (...args: unknown[]) => completeMock(...args),
    cancel: (...args: unknown[]) => cancelMock(...args),
    searchAll: (...args: unknown[]) => searchAllMock(...args),
    hide: (...args: unknown[]) => hideMock(...args),
    unhide: (...args: unknown[]) => unhideMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  };
});

const summariesForMock = vi.fn();
const summaryForMock = vi.fn();
vi.mock("@/features/ratings/server/rating.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/ratings/server/rating.queries")>();
  return {
    ...actual,
    summariesFor: (...args: unknown[]) => summariesForMock(...args),
    summaryFor: (...args: unknown[]) => summaryForMock(...args),
  };
});

// `vi.mock` calls are hoisted by Vitest, so these already resolve against the
// mocked service/rating modules.
import {
  MissionAccessDeniedError,
  MissionConflictError,
  MissionNotFoundError,
} from "@/features/missions/server/mission.service";
import { UserSuspendedError } from "@/features/users/server/user.service";
import { RATING_SUMMARY_NONE } from "@/features/ratings/server/rating.queries";
import { middleware } from "@/middleware";
import { GET as feedRoute, POST as createRoute } from "@/app/api/v1/missions/route";
import { GET as myMissionsRoute } from "@/app/api/v1/missions/my-missions/route";
import { GET as myJobsRoute } from "@/app/api/v1/missions/my-jobs/route";
import { GET as adminListRoute } from "@/app/api/v1/missions/all/route";
import { DELETE as deleteRoute, GET as detailRoute, PUT as updateRoute } from "@/app/api/v1/missions/[id]/route";
import { POST as startRoute } from "@/app/api/v1/missions/[id]/start/route";
import { POST as completeRoute } from "@/app/api/v1/missions/[id]/complete/route";
import { POST as cancelRoute } from "@/app/api/v1/missions/[id]/cancel/route";
import { POST as hideRoute } from "@/app/api/v1/missions/[id]/hide/route";
import { POST as unhideRoute } from "@/app/api/v1/missions/[id]/unhide/route";
import { POST as removeRoute } from "@/app/api/v1/missions/[id]/remove/route";

const DESIGNER_ID = 7;
const PILOT_ID = 42;
const ADMIN_ID = 80;

/** The context Next.js hands a non-dynamic route handler. */
const listContext = { params: Promise.resolve({}) };

/** The context Next.js hands `missions/[id]` for the given path segment. */
function idContext(id: string) {
  return { params: Promise.resolve({ id }) };
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
  method: "POST" | "PUT" | "DELETE",
  body: unknown,
  userId = DESIGNER_ID,
  role: UserRole = "DESIGNER",
): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...authHeaders(userId, role) },
    body: JSON.stringify(body),
  });
}

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: DESIGNER_ID,
    username: "dana",
    email: "dana@example.com",
    passwordHash: "hash",
    role: "DESIGNER",
    suspended: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * A mission with no owner at all — `MissionControllerTest.legacyMission()`.
 * `mission.user_id` is nullable (V4: rows created before authentication
 * existed), so every response path has to survive one.
 */
function legacyMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 1,
    name: "Legacy survey",
    description: null,
    status: "PUBLISHED",
    moderation: "VISIBLE",
    userId: null,
    awardedPilotId: null,
    startTime: null,
    endTime: null,
    location: null,
    biddingDeadline: null,
    waypoints: null,
    geofence: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    designer: null,
    ...overrides,
  };
}

/** The same mission, owned by a real designer. */
function ownedMission(overrides: Partial<Mission> = {}): Mission {
  return legacyMission({ userId: DESIGNER_ID, designer: fakeUser(), ...overrides });
}

/** A request body that satisfies every rule in `missionRequestSchema`. */
function validRequestBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Orchard survey",
    description: "Fly the north rows",
    status: "PUBLISHED",
    startTime: "2026-05-01T08:00:00.000Z",
    endTime: "2026-05-01T10:00:00.000Z",
    location: "Novi Sad",
    biddingDeadline: "2026-04-25",
    waypoints: [
      { lat: 45.25, lng: 19.83, altitude: 40, action: "PHOTO" },
      { lat: 45.26, lng: 19.84, altitude: 40, action: "HOVER", hoverDurationSeconds: 30 },
    ],
    geofence: { type: "CIRCLE", center: { lat: 45.25, lng: 19.83 }, radiusMeters: 500 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `when(ratingService.summariesFor(any())).thenReturn(Map.of())` /
  // `when(ratingService.summaryFor(any())).thenReturn(RatingSummary.NONE)`.
  summariesForMock.mockResolvedValue(new Map());
  summaryForMock.mockResolvedValue(RATING_SUMMARY_NONE);
});

describe("GET /api/v1/missions (the open feed)", () => {
  it("survives a mission with no owner (theOpenFeedSurvivesAMissionWithNoOwner)", async () => {
    findOpenMock.mockResolvedValue([legacyMission()]);

    const response = await feedRoute(getRequest("http://localhost/api/v1/missions"), listContext);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: 1,
      userId: null,
      designerEmail: null,
      designerName: null,
      designerSuspended: false,
      designerRating: 0,
      designerRatingCount: 0,
    });
  });

  it("passes no filters at all when the query string is empty", async () => {
    findOpenMock.mockResolvedValue([]);

    await feedRoute(getRequest("http://localhost/api/v1/missions"), listContext);

    expect(findOpenMock).toHaveBeenCalledWith(null, null, null);
  });

  it("forwards location, keyword and date verbatim — normalising is the service's job", async () => {
    findOpenMock.mockResolvedValue([]);

    await feedRoute(
      getRequest(
        "http://localhost/api/v1/missions?location=Novi%20Sad&keyword=Orchard&date=2026-05-01",
      ),
      listContext,
    );

    expect(findOpenMock).toHaveBeenCalledWith("Novi Sad", "Orchard", "2026-05-01");
  });

  it("treats an empty date parameter as absent, like Spring's WebDataBinder", async () => {
    findOpenMock.mockResolvedValue([]);

    await feedRoute(getRequest("http://localhost/api/v1/missions?date="), listContext);

    expect(findOpenMock).toHaveBeenCalledWith(null, null, null);
  });

  it("rejects a malformed date with 400 and never reaches the service", async () => {
    const response = await feedRoute(
      getRequest("http://localhost/api/v1/missions?date=01-05-2026"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.status).toBe("BAD_REQUEST");
    expect(body.data).toMatchObject({ date: "must be a date in yyyy-MM-dd format" });
    expect(findOpenMock).not.toHaveBeenCalled();
  });

  it("rejects a date that is not a real calendar day", async () => {
    const response = await feedRoute(
      getRequest("http://localhost/api/v1/missions?date=2026-02-31"),
      listContext,
    );

    expect(response.status).toBe(400);
    expect(findOpenMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/missions/my-missions", () => {
  it("returns the caller's own missions (ownedMissionsAreStillReturnedForARealOwner)", async () => {
    findOwnedByMock.mockResolvedValue([ownedMission()]);

    const response = await myMissionsRoute(
      getRequest("http://localhost/api/v1/missions/my-missions"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      userId: DESIGNER_ID,
      designerName: "dana",
      designerEmail: "dana@example.com",
    });
    expect(findOwnedByMock).toHaveBeenCalledWith(DESIGNER_ID);
  });

  it("takes the owner id from the verified token headers, never from the query string", async () => {
    findOwnedByMock.mockResolvedValue([]);

    await myMissionsRoute(
      getRequest("http://localhost/api/v1/missions/my-missions?userId=99", 42, "PILOT"),
      listContext,
    );

    expect(findOwnedByMock).toHaveBeenCalledWith(42);
  });
});

describe("GET /api/v1/missions/{id}", () => {
  it("renders a single mission with no owner (aSingleMissionWithNoOwnerStillRenders)", async () => {
    findByIdMock.mockResolvedValue(legacyMission());

    const response = await detailRoute(
      getRequest("http://localhost/api/v1/missions/1"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: 1,
      userId: null,
      designerName: null,
      designerSuspended: false,
      designerRating: 0,
    });
    expect(findByIdMock).toHaveBeenCalledWith(1, DESIGNER_ID);
  });

  it("answers 404 — not 403 — for a mission the caller may not see", async () => {
    findByIdMock.mockRejectedValue(new MissionNotFoundError(1));

    const response = await detailRoute(
      getRequest("http://localhost/api/v1/missions/1", 99, "PILOT"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ status: "NOT_FOUND", message: "Mission 1 not found" });
  });

  it("rejects a non-numeric id with 400, mirroring the @PathVariable Long conversion failure", async () => {
    const response = await detailRoute(
      getRequest("http://localhost/api/v1/missions/abc"),
      idContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ id: "must be a number" });
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/missions", () => {
  it("creates the mission for a designer: 201, Location header, MissionResponse body", async () => {
    createMock.mockResolvedValue(ownedMission({ id: 12 }));

    const response = await createRoute(
      jsonRequest("http://localhost/api/v1/missions", "POST", validRequestBody()),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("http://localhost/api/v1/missions/12");
    expect(body).toMatchObject({ id: 12, userId: DESIGNER_ID, designerName: "dana" });
  });

  it("hands the service exactly the nine fields MissionMapper.toEntity sets, and the caller id", async () => {
    createMock.mockResolvedValue(ownedMission({ id: 12 }));

    await createRoute(
      jsonRequest("http://localhost/api/v1/missions", "POST", validRequestBody()),
      listContext,
    );

    expect(createMock).toHaveBeenCalledWith(
      {
        name: "Orchard survey",
        description: "Fly the north rows",
        status: "PUBLISHED",
        startTime: new Date("2026-05-01T08:00:00.000Z"),
        endTime: new Date("2026-05-01T10:00:00.000Z"),
        location: "Novi Sad",
        biddingDeadline: "2026-04-25",
        waypoints: [
          { lat: 45.25, lng: 19.83, altitude: 40, action: "PHOTO" },
          { lat: 45.26, lng: 19.84, altitude: 40, action: "HOVER", hoverDurationSeconds: 30 },
        ],
        geofence: { type: "CIRCLE", center: { lat: 45.25, lng: 19.83 }, radiusMeters: 500 },
      },
      DESIGNER_ID,
    );
  });

  it("narrows a POLYGON geofence into the domain union", async () => {
    createMock.mockResolvedValue(ownedMission({ id: 12 }));
    const points = [
      { lat: 45.2, lng: 19.8 },
      { lat: 45.3, lng: 19.8 },
      { lat: 45.3, lng: 19.9 },
    ];

    await createRoute(
      jsonRequest(
        "http://localhost/api/v1/missions",
        "POST",
        validRequestBody({ geofence: { type: "POLYGON", points } }),
      ),
      listContext,
    );

    expect(createMock.mock.calls[0][0].geofence).toEqual({ type: "POLYGON", points });
  });

  it("turns absent optional fields into null, not undefined", async () => {
    createMock.mockResolvedValue(ownedMission({ id: 12 }));
    const body = validRequestBody();
    delete (body as Record<string, unknown>).description;
    delete (body as Record<string, unknown>).location;
    delete (body as Record<string, unknown>).biddingDeadline;
    delete (body as Record<string, unknown>).geofence;

    await createRoute(jsonRequest("http://localhost/api/v1/missions", "POST", body), listContext);

    expect(createMock.mock.calls[0][0]).toMatchObject({
      description: null,
      location: null,
      biddingDeadline: null,
      geofence: null,
    });
  });

  it("rejects a pilot with 403 and creates nothing (hasRole('DESIGNER'))", async () => {
    const response = await createRoute(
      jsonRequest("http://localhost/api/v1/missions", "POST", validRequestBody(), 42, "PILOT"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects an admin too — hasRole('DESIGNER') is a single exact role", async () => {
    const response = await createRoute(
      jsonRequest("http://localhost/api/v1/missions", "POST", validRequestBody(), 1, "ADMIN"),
      listContext,
    );

    expect(response.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("answers 400 before 403 for a wrong-role caller with an invalid body, as Spring does", async () => {
    // Spring resolves and validates `@Valid` handler arguments before the
    // `@PreAuthorize` advice around the controller bean runs, so validation
    // wins this race there; this pins that the port keeps the same ordering.
    const response = await createRoute(
      jsonRequest(
        "http://localhost/api/v1/missions",
        "POST",
        validRequestBody({ name: "  " }),
        42,
        "PILOT",
      ),
      listContext,
    );

    expect(response.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a missing name with 400 and a field error", async () => {
    const body = validRequestBody();
    delete (body as Record<string, unknown>).name;

    const response = await createRoute(
      jsonRequest("http://localhost/api/v1/missions", "POST", body),
      listContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.message).toBe("Data validation failed");
    expect(payload.data).toMatchObject({ name: "must not be blank" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a flight path of fewer than 2 waypoints", async () => {
    const response = await createRoute(
      jsonRequest(
        "http://localhost/api/v1/missions",
        "POST",
        validRequestBody({
          waypoints: [{ lat: 45.25, lng: 19.83, altitude: 40, action: "PHOTO" }],
        }),
      ),
      listContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.data).toMatchObject({ waypoints: "a flight path needs at least 2 waypoints" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a HOVER waypoint with no hover duration, keyed by the indexed field path", async () => {
    const response = await createRoute(
      jsonRequest(
        "http://localhost/api/v1/missions",
        "POST",
        validRequestBody({
          waypoints: [
            { lat: 45.25, lng: 19.83, altitude: 40, action: "HOVER" },
            { lat: 45.26, lng: 19.84, altitude: 40, action: "PHOTO" },
          ],
        }),
      ),
      listContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.data).toMatchObject({
      "waypoints[0].hoverDurationSeconds": "must be greater than 0 for a HOVER waypoint",
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects an inconsistent geofence (a CIRCLE with no radius)", async () => {
    const response = await createRoute(
      jsonRequest(
        "http://localhost/api/v1/missions",
        "POST",
        validRequestBody({ geofence: { type: "CIRCLE", center: { lat: 45.25, lng: 19.83 } } }),
      ),
      listContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.data).toMatchObject({
      "geofence.consistent":
        "a CIRCLE needs center + radiusMeters; a POLYGON needs at least 3 points",
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with 400", async () => {
    const response = await createRoute(
      new Request("http://localhost/api/v1/missions", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(DESIGNER_ID, "DESIGNER") },
        body: "{ not json",
      }),
      listContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.message).toBe("Malformed or unreadable request body");
  });
});

describe("PUT /api/v1/missions/{id}", () => {
  it("applies an owner's edit and returns the updated MissionResponse", async () => {
    updateMock.mockResolvedValue(ownedMission({ name: "Renamed" }));

    const response = await updateRoute(
      jsonRequest(
        "http://localhost/api/v1/missions/1",
        "PUT",
        validRequestBody({ name: "Renamed" }),
      ),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: 1, name: "Renamed", userId: DESIGNER_ID });
    expect(updateMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ name: "Renamed" }),
      DESIGNER_ID,
    );
  });

  it("never forwards status — the draft the service receives carries the request's, and the service drops it", async () => {
    updateMock.mockResolvedValue(ownedMission());

    await updateRoute(
      jsonRequest(
        "http://localhost/api/v1/missions/1",
        "PUT",
        validRequestBody({ status: "COMPLETED" }),
      ),
      idContext("1"),
    );

    // Mirrors the source exactly: `mapper.toEntity(request)` sets `status` on
    // the entity it builds, and `MissionService.update` simply never copies
    // that field onto the loaded row (see `mission.service.ts`).
    expect(updateMock.mock.calls[0][1]).toMatchObject({ status: "COMPLETED" });
  });

  it("answers 403 with MissionAccessDenied parity when the caller is not the owner", async () => {
    updateMock.mockRejectedValue(new MissionAccessDeniedError(1));

    const response = await updateRoute(
      jsonRequest("http://localhost/api/v1/missions/1", "PUT", validRequestBody(), 99, "DESIGNER"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      status: "FORBIDDEN",
      message: "You are not allowed to modify mission 1",
    });
  });

  it("rejects a pilot with 403 and updates nothing", async () => {
    const response = await updateRoute(
      jsonRequest("http://localhost/api/v1/missions/1", "PUT", validRequestBody(), 42, "PILOT"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a mission that does not exist", async () => {
    updateMock.mockRejectedValue(new MissionNotFoundError(1));

    const response = await updateRoute(
      jsonRequest("http://localhost/api/v1/missions/1", "PUT", validRequestBody()),
      idContext("1"),
    );

    expect(response.status).toBe(404);
  });

  it("validates the body with the same schema as create", async () => {
    const response = await updateRoute(
      jsonRequest("http://localhost/api/v1/missions/1", "PUT", validRequestBody({ waypoints: [] })),
      idContext("1"),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.data).toMatchObject({ waypoints: "a flight path needs at least 2 waypoints" });
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/missions/{id}", () => {
  it("deletes the owner's mission and answers 204 with no body", async () => {
    deleteMissionMock.mockResolvedValue(undefined);

    const response = await deleteRoute(
      jsonRequest("http://localhost/api/v1/missions/1", "DELETE", undefined),
      idContext("1"),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(deleteMissionMock).toHaveBeenCalledWith(1, DESIGNER_ID);
  });

  it("rejects a pilot with 403 and deletes nothing", async () => {
    const response = await deleteRoute(
      jsonRequest("http://localhost/api/v1/missions/1", "DELETE", undefined, 42, "PILOT"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect(deleteMissionMock).not.toHaveBeenCalled();
  });

  it("answers 403 when a designer deletes someone else's mission", async () => {
    deleteMissionMock.mockRejectedValue(new MissionAccessDeniedError(1));

    const response = await deleteRoute(
      jsonRequest("http://localhost/api/v1/missions/1", "DELETE", undefined, 99, "DESIGNER"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.message).toBe("You are not allowed to modify mission 1");
  });

  it("answers 404 for a mission that does not exist", async () => {
    deleteMissionMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await deleteRoute(
      jsonRequest("http://localhost/api/v1/missions/9", "DELETE", undefined),
      idContext("9"),
    );

    expect(response.status).toBe(404);
  });
});

/**
 * The lifecycle POSTs as the client sends them: path plus token, no body at
 * all — the source's `start`/`complete`/`cancel` take only `@PathVariable id`
 * and `@AuthenticationPrincipal userId`.
 */
function actionRequest(url: string, userId: number, role: UserRole): Request {
  return new Request(url, { method: "POST", headers: authHeaders(userId, role) });
}

/** The mission as it looks once a bid has been accepted on it. */
function awardedMission(overrides: Partial<Mission> = {}): Mission {
  return ownedMission({ status: "AWARDED", awardedPilotId: PILOT_ID, ...overrides });
}

describe("POST /api/v1/missions/{id}/start", () => {
  it("moves the mission to IN_PROGRESS and answers 200 with the MissionResponse", async () => {
    startMock.mockResolvedValue(awardedMission({ status: "IN_PROGRESS" }));

    const response = await startRoute(
      actionRequest("http://localhost/api/v1/missions/1/start", PILOT_ID, "PILOT"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: 1,
      status: "IN_PROGRESS",
      awardedPilotId: PILOT_ID,
      designerName: "dana",
    });
  });

  it("hands the service the mission id and the acting pilot from the token", async () => {
    startMock.mockResolvedValue(awardedMission({ status: "IN_PROGRESS" }));

    await startRoute(
      actionRequest("http://localhost/api/v1/missions/1/start?userId=99", PILOT_ID, "PILOT"),
      idContext("1"),
    );

    // Never the query string: the transition is attributed to the verified caller.
    expect(startMock).toHaveBeenCalledWith(1, PILOT_ID);
  });

  it("rejects a designer with 403 and starts nothing (hasRole('PILOT'))", async () => {
    const response = await startRoute(
      actionRequest("http://localhost/api/v1/missions/1/start", DESIGNER_ID, "DESIGNER"),
      idContext("1"),
    );
    const body = await response.json();

    // The mirror image of `/cancel`: the mission's own designer may not start it.
    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(startMock).not.toHaveBeenCalled();
  });

  it("rejects an admin too — hasRole('PILOT') is a single exact role", async () => {
    const response = await startRoute(
      actionRequest("http://localhost/api/v1/missions/1/start", 1, "ADMIN"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect(startMock).not.toHaveBeenCalled();
  });

  it("answers 403 with the mission's message when the caller is not the awarded pilot", async () => {
    startMock.mockRejectedValue(new MissionAccessDeniedError(1));

    const response = await startRoute(
      actionRequest("http://localhost/api/v1/missions/1/start", 99, "PILOT"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      status: "FORBIDDEN",
      message: "You are not allowed to modify mission 1",
    });
  });

  it("answers 403 while the awarded pilot's account is suspended", async () => {
    startMock.mockRejectedValue(new UserSuspendedError());

    const response = await startRoute(
      actionRequest("http://localhost/api/v1/missions/1/start", PILOT_ID, "PILOT"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.message).toBe("This account is suspended and cannot perform this action");
  });

  it("answers 409 naming the status a mission cannot be started from", async () => {
    startMock.mockRejectedValue(
      new MissionConflictError("Mission 1 cannot be started from status PUBLISHED"),
    );

    const response = await startRoute(
      actionRequest("http://localhost/api/v1/missions/1/start", PILOT_ID, "PILOT"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      status: "CONFLICT",
      message: "Mission 1 cannot be started from status PUBLISHED",
    });
  });

  it("answers 404 for a mission that does not exist", async () => {
    startMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await startRoute(
      actionRequest("http://localhost/api/v1/missions/9/start", PILOT_ID, "PILOT"),
      idContext("9"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a non-numeric id with 400 and starts nothing", async () => {
    const response = await startRoute(
      actionRequest("http://localhost/api/v1/missions/abc/start", PILOT_ID, "PILOT"),
      idContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ id: "must be a number" });
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/missions/{id}/complete", () => {
  it("moves the mission to COMPLETED and answers 200 with the MissionResponse", async () => {
    completeMock.mockResolvedValue(awardedMission({ status: "COMPLETED" }));

    const response = await completeRoute(
      actionRequest("http://localhost/api/v1/missions/1/complete", PILOT_ID, "PILOT"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: 1, status: "COMPLETED", awardedPilotId: PILOT_ID });
    expect(completeMock).toHaveBeenCalledWith(1, PILOT_ID);
  });

  it("rejects a designer with 403 and completes nothing (hasRole('PILOT'))", async () => {
    const response = await completeRoute(
      actionRequest("http://localhost/api/v1/missions/1/complete", DESIGNER_ID, "DESIGNER"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("answers 403 when the caller is not the awarded pilot", async () => {
    completeMock.mockRejectedValue(new MissionAccessDeniedError(1));

    const response = await completeRoute(
      actionRequest("http://localhost/api/v1/missions/1/complete", 99, "PILOT"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).message).toBe("You are not allowed to modify mission 1");
  });

  it("answers 409 naming the status a mission cannot be completed from", async () => {
    // A mission that was awarded but never started, and equally the message a
    // second completion attempt gets — the guard demands IN_PROGRESS.
    completeMock.mockRejectedValue(
      new MissionConflictError("Mission 1 cannot be completed from status AWARDED"),
    );

    const response = await completeRoute(
      actionRequest("http://localhost/api/v1/missions/1/complete", PILOT_ID, "PILOT"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.message).toBe("Mission 1 cannot be completed from status AWARDED");
  });

  it("answers 404 for a mission that does not exist", async () => {
    completeMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await completeRoute(
      actionRequest("http://localhost/api/v1/missions/9/complete", PILOT_ID, "PILOT"),
      idContext("9"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a non-numeric id with 400 and completes nothing", async () => {
    const response = await completeRoute(
      actionRequest("http://localhost/api/v1/missions/abc/complete", PILOT_ID, "PILOT"),
      idContext("abc"),
    );

    expect(response.status).toBe(400);
    expect(completeMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/missions/{id}/cancel", () => {
  it("cancels the owner's mission and answers 200 with the MissionResponse alone", async () => {
    cancelMock.mockResolvedValue(awardedMission({ status: "CANCELLED" }));

    const response = await cancelRoute(
      actionRequest("http://localhost/api/v1/missions/1/cancel", DESIGNER_ID, "DESIGNER"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: 1, status: "CANCELLED", userId: DESIGNER_ID });
    // The bids the service also rejected are not part of the response: the
    // source returns a single `MissionResponse`.
    expect(Array.isArray(body)).toBe(false);
    expect(body).not.toHaveProperty("bids");
    expect(cancelMock).toHaveBeenCalledWith(1, DESIGNER_ID);
  });

  it("rejects a pilot with 403 and cancels nothing (hasRole('DESIGNER'))", async () => {
    const response = await cancelRoute(
      actionRequest("http://localhost/api/v1/missions/1/cancel", PILOT_ID, "PILOT"),
      idContext("1"),
    );
    const body = await response.json();

    // Not even the awarded pilot may cancel — only the mission's creator.
    expect(response.status).toBe(403);
    expect(body.message).toBe("You do not have permission to perform this action");
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("rejects an admin too — hasRole('DESIGNER') is a single exact role", async () => {
    const response = await cancelRoute(
      actionRequest("http://localhost/api/v1/missions/1/cancel", 1, "ADMIN"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("answers 403 when a designer cancels someone else's mission", async () => {
    cancelMock.mockRejectedValue(new MissionAccessDeniedError(1));

    const response = await cancelRoute(
      actionRequest("http://localhost/api/v1/missions/1/cancel", 99, "DESIGNER"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).message).toBe("You are not allowed to modify mission 1");
  });

  it("answers 409 naming the status a mission cannot be cancelled from", async () => {
    cancelMock.mockRejectedValue(
      new MissionConflictError("Mission 1 cannot be cancelled from status COMPLETED"),
    );

    const response = await cancelRoute(
      actionRequest("http://localhost/api/v1/missions/1/cancel", DESIGNER_ID, "DESIGNER"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      status: "CONFLICT",
      message: "Mission 1 cannot be cancelled from status COMPLETED",
    });
  });

  it("answers 404 for a mission that does not exist", async () => {
    cancelMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await cancelRoute(
      actionRequest("http://localhost/api/v1/missions/9/cancel", DESIGNER_ID, "DESIGNER"),
      idContext("9"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a non-numeric id with 400 and cancels nothing", async () => {
    const response = await cancelRoute(
      actionRequest("http://localhost/api/v1/missions/abc/cancel", DESIGNER_ID, "DESIGNER"),
      idContext("abc"),
    );

    expect(response.status).toBe(400);
    expect(cancelMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/missions/my-jobs", () => {
  it("returns the missions awarded to the calling pilot", async () => {
    findAwardedToMock.mockResolvedValue([awardedMission()]);

    const response = await myJobsRoute(
      getRequest("http://localhost/api/v1/missions/my-jobs", PILOT_ID, "PILOT"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: 1,
      status: "AWARDED",
      awardedPilotId: PILOT_ID,
      designerName: "dana",
    });
    expect(findAwardedToMock).toHaveBeenCalledWith(PILOT_ID);
  });

  it("takes the pilot id from the verified token headers, never from the query string", async () => {
    findAwardedToMock.mockResolvedValue([]);

    await myJobsRoute(
      getRequest("http://localhost/api/v1/missions/my-jobs?userId=99", PILOT_ID, "PILOT"),
      listContext,
    );

    expect(findAwardedToMock).toHaveBeenCalledWith(PILOT_ID);
  });

  it("rejects a designer with 403 (hasRole('PILOT')), unlike my-missions", async () => {
    const response = await myJobsRoute(
      getRequest("http://localhost/api/v1/missions/my-jobs", DESIGNER_ID, "DESIGNER"),
      listContext,
    );
    const body = await response.json();

    // The source guards this endpoint with hasRole('PILOT') while
    // `/my-missions` is only isAuthenticated() — a designer gets a 403 here
    // where they get an empty list there. Mirrored, not smoothed over.
    expect(response.status).toBe(403);
    expect(body.message).toBe("You do not have permission to perform this action");
    expect(findAwardedToMock).not.toHaveBeenCalled();
  });

  it("rejects an admin too", async () => {
    const response = await myJobsRoute(
      getRequest("http://localhost/api/v1/missions/my-jobs", 1, "ADMIN"),
      listContext,
    );

    expect(response.status).toBe(403);
    expect(findAwardedToMock).not.toHaveBeenCalled();
  });

  it("returns the empty list for a pilot with no jobs — never a 404", async () => {
    findAwardedToMock.mockResolvedValue([]);

    const response = await myJobsRoute(
      getRequest("http://localhost/api/v1/missions/my-jobs", PILOT_ID, "PILOT"),
      listContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});

/** `new PageImpl<>(List.of(mission), pageable, total)`. */
function page(
  content: Mission[],
  pageIndex: number,
  size: number,
  totalElements: number,
): Page<Mission> {
  return { content, request: { page: pageIndex, size }, totalElements };
}

describe("GET /api/v1/missions/all (the admin listing)", () => {
  it("wraps the page and survives a mission with no owner (adminListWrapsThePageAndSurvivesAMissionWithNoOwner)", async () => {
    searchAllMock.mockResolvedValue(page([legacyMission()], 0, 20, 1));

    const response = await adminListRoute(
      getRequest("http://localhost/api/v1/missions/all?q=orchard", ADMIN_ID, "ADMIN"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.content).toHaveLength(1);
    // The ownerless row still renders: `ratingOf` answers `NONE` for a null
    // designer id rather than looking it up in an immutable empty map.
    expect(body.content[0]).toMatchObject({
      id: 1,
      userId: null,
      designerEmail: null,
      designerName: null,
      designerSuspended: false,
      designerRating: 0,
      designerRatingCount: 0,
    });
    expect(searchAllMock).toHaveBeenCalledWith("orchard", { page: 0, size: 20 });
    // `verify(service, never()).findOpen(any(), any(), any())` — the admin
    // listing is not the open feed with a filter bolted on.
    expect(findOpenMock).not.toHaveBeenCalled();
  });

  it("enriches every row with its designer's rating in one aggregate query", async () => {
    searchAllMock.mockResolvedValue(page([ownedMission(), ownedMission({ id: 2 })], 0, 20, 2));
    summariesForMock.mockResolvedValue(new Map([[DESIGNER_ID, { average: 4.5, count: 12 }]]));

    const response = await adminListRoute(
      getRequest("http://localhost/api/v1/missions/all", ADMIN_ID, "ADMIN"),
      listContext,
    );
    const body = await response.json();

    expect(body.content[0]).toMatchObject({ designerRating: 4.5, designerRatingCount: 12 });
    expect(body.content[1]).toMatchObject({ designerRating: 4.5, designerRatingCount: 12 });
    // One lookup for the whole page, not one per card.
    expect(summariesForMock).toHaveBeenCalledTimes(1);
    expect(summariesForMock).toHaveBeenCalledWith([DESIGNER_ID, DESIGNER_ID]);
    expect(summaryForMock).not.toHaveBeenCalled();
  });

  it("returns the PagedModel envelope the Angular pager reads", async () => {
    searchAllMock.mockResolvedValue(page([legacyMission()], 1, 5, 6));

    const response = await adminListRoute(
      getRequest("http://localhost/api/v1/missions/all?page=1&size=5", ADMIN_ID, "ADMIN"),
      listContext,
    );
    const body = await response.json();

    expect(searchAllMock).toHaveBeenCalledWith(null, { page: 1, size: 5 });
    expect(body.page).toEqual({ size: 5, number: 1, totalElements: 6, totalPages: 2 });
  });

  it("applies the @PageableDefault of size 20, page 0 when the query string is empty", async () => {
    searchAllMock.mockResolvedValue(page([], 0, 20, 0));

    await adminListRoute(
      getRequest("http://localhost/api/v1/missions/all", ADMIN_ID, "ADMIN"),
      listContext,
    );

    // A missing `q` reaches the service as null — "everything".
    expect(searchAllMock).toHaveBeenCalledWith(null, { page: 0, size: 20 });
  });

  it("forwards q verbatim — normalising it into a LIKE pattern is the service's job", async () => {
    searchAllMock.mockResolvedValue(page([], 0, 20, 0));

    await adminListRoute(
      getRequest("http://localhost/api/v1/missions/all?q=%20Orchard%20", ADMIN_ID, "ADMIN"),
      listContext,
    );

    expect(searchAllMock).toHaveBeenCalledWith(" Orchard ", { page: 0, size: 20 });
  });

  it("returns an empty page (not 404) when nothing matches", async () => {
    searchAllMock.mockResolvedValue(page([], 0, 20, 0));

    const response = await adminListRoute(
      getRequest("http://localhost/api/v1/missions/all?q=nothing", ADMIN_ID, "ADMIN"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.content).toEqual([]);
    expect(body.page).toEqual({ size: 20, number: 0, totalElements: 0, totalPages: 0 });
  });

  it("rejects a designer with 403 and never reaches the service (hasRole('ADMIN'))", async () => {
    const response = await adminListRoute(
      getRequest("http://localhost/api/v1/missions/all", DESIGNER_ID, "DESIGNER"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      data: null,
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(searchAllMock).not.toHaveBeenCalled();
  });

  it("rejects a pilot with 403 — this listing shows hidden and cancelled missions", async () => {
    const response = await adminListRoute(
      getRequest("http://localhost/api/v1/missions/all", PILOT_ID, "PILOT"),
      listContext,
    );

    expect(response.status).toBe(403);
    expect(searchAllMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/missions/all")),
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/v1/missions/{id}/hide", () => {
  it("hides the mission and answers 200 with the updated MissionResponse", async () => {
    hideMock.mockResolvedValue(ownedMission({ moderation: "HIDDEN" }));

    const response = await hideRoute(
      actionRequest("http://localhost/api/v1/missions/1/hide", ADMIN_ID, "ADMIN"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: 1, moderation: "HIDDEN", designerName: "dana" });
  });

  it("hands the service the mission id and the acting admin from the token", async () => {
    hideMock.mockResolvedValue(ownedMission({ moderation: "HIDDEN" }));

    await hideRoute(
      actionRequest("http://localhost/api/v1/missions/1/hide?userId=99", ADMIN_ID, "ADMIN"),
      idContext("1"),
    );

    // Never the query string: the audit row names the verified caller.
    expect(hideMock).toHaveBeenCalledWith(1, ADMIN_ID);
  });

  it("rejects a designer with 403 and hides nothing — even their own mission", async () => {
    const response = await hideRoute(
      actionRequest("http://localhost/api/v1/missions/1/hide", DESIGNER_ID, "DESIGNER"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(hideMock).not.toHaveBeenCalled();
  });

  it("rejects a pilot with 403", async () => {
    const response = await hideRoute(
      actionRequest("http://localhost/api/v1/missions/1/hide", PILOT_ID, "PILOT"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect(hideMock).not.toHaveBeenCalled();
  });

  it("answers 409 for an already hidden mission — hiding is not idempotent", async () => {
    hideMock.mockRejectedValue(
      new MissionConflictError("Mission 1 cannot go from HIDDEN to HIDDEN"),
    );

    const response = await hideRoute(
      actionRequest("http://localhost/api/v1/missions/1/hide", ADMIN_ID, "ADMIN"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      status: "CONFLICT",
      message: "Mission 1 cannot go from HIDDEN to HIDDEN",
    });
  });

  it("answers 404 for a mission that does not exist", async () => {
    hideMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await hideRoute(
      actionRequest("http://localhost/api/v1/missions/9/hide", ADMIN_ID, "ADMIN"),
      idContext("9"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a non-numeric id with 400 and hides nothing", async () => {
    const response = await hideRoute(
      actionRequest("http://localhost/api/v1/missions/abc/hide", ADMIN_ID, "ADMIN"),
      idContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ id: "must be a number" });
    expect(hideMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/missions/1/hide")),
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/v1/missions/{id}/unhide", () => {
  it("returns the mission to the marketplace and answers 200 with the MissionResponse", async () => {
    unhideMock.mockResolvedValue(ownedMission({ moderation: "VISIBLE" }));

    const response = await unhideRoute(
      actionRequest("http://localhost/api/v1/missions/1/unhide", ADMIN_ID, "ADMIN"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: 1, moderation: "VISIBLE" });
    expect(unhideMock).toHaveBeenCalledWith(1, ADMIN_ID);
  });

  it("rejects a designer with 403 and unhides nothing", async () => {
    const response = await unhideRoute(
      actionRequest("http://localhost/api/v1/missions/1/unhide", DESIGNER_ID, "DESIGNER"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect(unhideMock).not.toHaveBeenCalled();
  });

  it("rejects a pilot with 403", async () => {
    const response = await unhideRoute(
      actionRequest("http://localhost/api/v1/missions/1/unhide", PILOT_ID, "PILOT"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect(unhideMock).not.toHaveBeenCalled();
  });

  it("answers 409 for a mission that is not currently hidden", async () => {
    unhideMock.mockRejectedValue(
      new MissionConflictError("Mission 1 cannot go from VISIBLE to VISIBLE"),
    );

    const response = await unhideRoute(
      actionRequest("http://localhost/api/v1/missions/1/unhide", ADMIN_ID, "ADMIN"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.message).toBe("Mission 1 cannot go from VISIBLE to VISIBLE");
  });

  it("answers 404 for a mission that does not exist", async () => {
    unhideMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await unhideRoute(
      actionRequest("http://localhost/api/v1/missions/9/unhide", ADMIN_ID, "ADMIN"),
      idContext("9"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a non-numeric id with 400 and unhides nothing", async () => {
    const response = await unhideRoute(
      actionRequest("http://localhost/api/v1/missions/abc/unhide", ADMIN_ID, "ADMIN"),
      idContext("abc"),
    );

    expect(response.status).toBe(400);
    expect(unhideMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/missions/1/unhide")),
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/v1/missions/{id}/remove", () => {
  it("deletes the mission and answers 204 with no body", async () => {
    removeMock.mockResolvedValue(undefined);

    const response = await removeRoute(
      actionRequest("http://localhost/api/v1/missions/1/remove", ADMIN_ID, "ADMIN"),
      idContext("1"),
    );

    // 204, not 200 with a MissionResponse: the mission no longer exists to
    // be returned, and the rating lookup a response body would need is never
    // made.
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(summaryForMock).not.toHaveBeenCalled();
  });

  it("hands the service the mission id and the acting admin from the token", async () => {
    removeMock.mockResolvedValue(undefined);

    await removeRoute(
      actionRequest("http://localhost/api/v1/missions/1/remove?userId=99", ADMIN_ID, "ADMIN"),
      idContext("1"),
    );

    // The audit row is the only trace a hard delete leaves, so it must name
    // the verified caller and never a query parameter.
    expect(removeMock).toHaveBeenCalledWith(1, ADMIN_ID);
  });

  it("rejects a designer with 403 and deletes nothing — even their own mission", async () => {
    const response = await removeRoute(
      actionRequest("http://localhost/api/v1/missions/1/remove", DESIGNER_ID, "DESIGNER"),
      idContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(removeMock).not.toHaveBeenCalled();
    // And the owner's own `DELETE /api/v1/missions/{id}` is a different path
    // entirely — this one never reaches it.
    expect(deleteMissionMock).not.toHaveBeenCalled();
  });

  it("rejects a pilot with 403", async () => {
    const response = await removeRoute(
      actionRequest("http://localhost/api/v1/missions/1/remove", PILOT_ID, "PILOT"),
      idContext("1"),
    );

    expect(response.status).toBe(403);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a mission that does not exist", async () => {
    removeMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await removeRoute(
      actionRequest("http://localhost/api/v1/missions/9/remove", ADMIN_ID, "ADMIN"),
      idContext("9"),
    );

    expect(response.status).toBe(404);
  });

  it("removes a mission in any state — there is no status guard on this path", async () => {
    removeMock.mockResolvedValue(undefined);

    const response = await removeRoute(
      actionRequest("http://localhost/api/v1/missions/1/remove", ADMIN_ID, "ADMIN"),
      idContext("1"),
    );

    expect(response.status).toBe(204);
    expect(removeMock).toHaveBeenCalledWith(1, ADMIN_ID);
  });

  it("rejects a non-numeric id with 400 and deletes nothing", async () => {
    const response = await removeRoute(
      actionRequest("http://localhost/api/v1/missions/abc/remove", ADMIN_ID, "ADMIN"),
      idContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ id: "must be a number" });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/missions/1/remove")),
    );
    expect(response.status).toBe(401);
  });
});
