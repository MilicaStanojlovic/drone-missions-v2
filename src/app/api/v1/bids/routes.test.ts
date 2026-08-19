import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import type { UserRole } from "@/db/schema";
import type { Bid } from "@/features/bids/bid.types";

/**
 * Route-level suite for the phase-3 bid endpoints:
 * `POST|GET /api/v1/bids/mission/{missionId}`, `GET /api/v1/bids/my`, and
 * `DELETE /api/v1/bids/{id}`.
 *
 * Shaped like `src/app/api/v1/missions/routes.test.ts` rather than the live-DB
 * notification/auth suites: `BidService` is mocked and the exported handlers
 * are called directly, so every assertion here is about what the *web layer*
 * contributes — the role guards, the request validation, the status codes, and
 * the `BidResponse` shape the mapper produces. The backend has no
 * `BidControllerTest` to mirror case-for-case (unlike `MissionControllerTest`),
 * so the cases below are derived from `BidController`'s annotations plus the
 * service errors it lets through.
 *
 * The rules that are *not* the web layer's are asserted only through the
 * errors the service raises, since mapping those onto status codes is exactly
 * the route layer's job: a hidden mission (or a suspended designer's) reads as
 * `MissionNotFoundError` -> 404, a closed mission / passed deadline /
 * already-decided bid as `BidConflictError` -> 409, and someone else's bid as
 * `BidNotFoundError` -> 404. Their real behavior is pinned one layer down in
 * `src/features/bids/bid.service.test.ts`.
 *
 * All four paths are authenticated-only — none are in `src/middleware.ts`'s
 * `PUBLIC_PATHS` — so the anonymous cases call `middleware()` directly, the
 * layer that actually rejects them in the deployed app (the precedent set by
 * `src/app/api/v1/notifications/routes.test.ts`), while the authenticated
 * cases pass the `x-user-id`/`x-user-role` headers `middleware.ts` would have
 * attached from the verified token's claims.
 *
 * `POST /api/v1/bids/{id}/accept` is Phase 5 and has no route to test.
 *
 * SOURCE: drone-missions-backend/.../web/controller/bid/BidController.java
 */

const placeMock = vi.fn();
const listForMissionMock = vi.fn();
const myBidsMock = vi.fn();
const withdrawMock = vi.fn();
vi.mock("@/features/bids/bid.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/bids/bid.service")>();
  return {
    ...actual,
    place: (...args: unknown[]) => placeMock(...args),
    listForMission: (...args: unknown[]) => listForMissionMock(...args),
    myBids: (...args: unknown[]) => myBidsMock(...args),
    withdraw: (...args: unknown[]) => withdrawMock(...args),
  };
});

// `vi.mock` calls are hoisted by Vitest, so these already resolve against the
// mocked service module (the two error classes come off `importOriginal`, so
// they are the real ones the handlers will see).
import { BidConflictError, BidNotFoundError } from "@/features/bids/bid.service";
import { MissionNotFoundError } from "@/features/missions/mission.service";
import { UserSuspendedError } from "@/features/users/user.service";
import { GET as listRoute, POST as placeRoute } from "./mission/[missionId]/route";
import { GET as myBidsRoute } from "./my/route";
import { DELETE as withdrawRoute } from "./[id]/route";

const PILOT_ID = 42;
const DESIGNER_ID = 7;
const MISSION_ID = 1;

/** The context Next.js hands a non-dynamic route handler. */
const listContext = { params: Promise.resolve({}) };

/** The context Next.js hands `bids/mission/[missionId]` for the given segment. */
function missionContext(missionId: string) {
  return { params: Promise.resolve({ missionId }) };
}

/** The context Next.js hands `bids/[id]` for the given segment. */
function idContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** The headers `src/middleware.ts` attaches from a verified token's claims. */
function authHeaders(userId: number, role: UserRole): Record<string, string> {
  return { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role };
}

function getRequest(url: string, userId = PILOT_ID, role: UserRole = "PILOT"): Request {
  return new Request(url, { headers: authHeaders(userId, role) });
}

function jsonRequest(
  url: string,
  method: "POST" | "DELETE",
  body: unknown,
  userId = PILOT_ID,
  role: UserRole = "PILOT",
): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...authHeaders(userId, role) },
    body: JSON.stringify(body),
  });
}

/** A bid as `bid.queries.ts` hands it out: relations resolved, `amount` a number. */
function fakeBid(overrides: Partial<Bid> = {}): Bid {
  return {
    id: 5,
    missionId: MISSION_ID,
    pilotId: PILOT_ID,
    amount: 1250.5,
    message: "Can fly Tuesday",
    status: "PENDING",
    createdAt: new Date("2026-04-01T09:00:00Z"),
    updatedAt: new Date("2026-04-01T09:00:00Z"),
    mission: { id: MISSION_ID, name: "Orchard survey" },
    pilot: { id: PILOT_ID, username: "pia" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/bids/mission/{missionId}", () => {
  it("places the bid for a pilot: 200 (not 201) with the BidResponse body", async () => {
    placeMock.mockResolvedValue(fakeBid());

    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", {
        amount: 1250.5,
        message: "Can fly Tuesday",
      }),
      missionContext("1"),
    );
    const body = await response.json();

    // `ResponseEntity.ok(...)`, and no Location header — the same call updates
    // an existing bid as often as it creates one.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(body).toMatchObject({
      id: 5,
      missionId: MISSION_ID,
      missionName: "Orchard survey",
      pilotId: PILOT_ID,
      pilotName: "pia",
      amount: 1250.5,
      message: "Can fly Tuesday",
      status: "PENDING",
    });
  });

  it("hands the service the mission id, the caller id from the token, and the two request fields", async () => {
    placeMock.mockResolvedValue(fakeBid());

    await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", {
        amount: 1250.5,
        message: "Can fly Tuesday",
      }),
      missionContext("1"),
    );

    expect(placeMock).toHaveBeenCalledWith(1, PILOT_ID, 1250.5, "Can fly Tuesday");
  });

  it("passes an omitted message through as undefined — the service decides what null means", async () => {
    placeMock.mockResolvedValue(fakeBid({ message: null }));

    await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { amount: 900 }),
      missionContext("1"),
    );

    expect(placeMock).toHaveBeenCalledWith(1, PILOT_ID, 900, undefined);
  });

  it("rejects a designer with 403 and places nothing (hasRole('PILOT'))", async () => {
    const response = await placeRoute(
      jsonRequest(
        "http://localhost/api/v1/bids/mission/1",
        "POST",
        { amount: 900 },
        DESIGNER_ID,
        "DESIGNER",
      ),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(placeMock).not.toHaveBeenCalled();
  });

  it("rejects an admin too — hasRole('PILOT') is a single exact role", async () => {
    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { amount: 900 }, 1, "ADMIN"),
      missionContext("1"),
    );

    expect(response.status).toBe(403);
    expect(placeMock).not.toHaveBeenCalled();
  });

  it("answers 400 before 403 for a wrong-role caller with an invalid body, as Spring does", async () => {
    // Spring resolves and validates `@Valid` handler arguments before the
    // `@PreAuthorize` advice around the controller bean runs, so validation
    // wins this race there; this pins that the port keeps the same ordering.
    const response = await placeRoute(
      jsonRequest(
        "http://localhost/api/v1/bids/mission/1",
        "POST",
        { amount: 0 },
        DESIGNER_ID,
        "DESIGNER",
      ),
      missionContext("1"),
    );

    expect(response.status).toBe(400);
    expect(placeMock).not.toHaveBeenCalled();
  });

  it("rejects a missing amount with 400 and a field error (@NotNull)", async () => {
    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { message: "hi" }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toBe("Data validation failed");
    expect(body.data).toMatchObject({ amount: "must not be null" });
    expect(placeMock).not.toHaveBeenCalled();
  });

  it("rejects a zero amount with 400 (@Positive)", async () => {
    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { amount: 0 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ amount: "must be greater than 0" });
    expect(placeMock).not.toHaveBeenCalled();
  });

  it("rejects a negative amount with 400", async () => {
    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { amount: -5 }),
      missionContext("1"),
    );

    expect(response.status).toBe(400);
    expect(placeMock).not.toHaveBeenCalled();
  });

  it("rejects a message longer than 500 characters with 400 (@Size(max = 500))", async () => {
    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", {
        amount: 900,
        message: "x".repeat(501),
      }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ message: "size must be between 0 and 500" });
    expect(placeMock).not.toHaveBeenCalled();
  });

  it("accepts a message of exactly 500 characters", async () => {
    placeMock.mockResolvedValue(fakeBid());

    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", {
        amount: 900,
        message: "x".repeat(500),
      }),
      missionContext("1"),
    );

    expect(response.status).toBe(200);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const response = await placeRoute(
      new Request("http://localhost/api/v1/bids/mission/1", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(PILOT_ID, "PILOT") },
        body: "{ not json",
      }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toBe("Malformed or unreadable request body");
  });

  it("rejects a non-numeric mission id with 400, mirroring the @PathVariable Long conversion failure", async () => {
    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/abc", "POST", { amount: 900 }),
      missionContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ missionId: "must be a number" });
    expect(placeMock).not.toHaveBeenCalled();
  });

  it("answers 404 — not 403 — for a hidden mission or one with a suspended designer", async () => {
    placeMock.mockRejectedValue(new MissionNotFoundError(MISSION_ID));

    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { amount: 900 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ status: "NOT_FOUND", message: "Mission 1 not found" });
  });

  it("answers 409 for a mission that is not open for bidding", async () => {
    placeMock.mockRejectedValue(new BidConflictError("Mission 1 is not open for bidding"));

    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { amount: 900 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      status: "CONFLICT",
      message: "Mission 1 is not open for bidding",
    });
  });

  it("answers 409 once the bidding deadline has passed", async () => {
    placeMock.mockRejectedValue(
      new BidConflictError("The bidding deadline for mission 1 has passed"),
    );

    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { amount: 900 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.message).toBe("The bidding deadline for mission 1 has passed");
  });

  it("answers 409 when the pilot's existing bid has already been decided", async () => {
    placeMock.mockRejectedValue(
      new BidConflictError("Bid 5 has already been decided and cannot be changed"),
    );

    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { amount: 900 }),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.message).toBe("Bid 5 has already been decided and cannot be changed");
  });

  it("answers 403 with the suspension message when the pilot's account is suspended", async () => {
    placeMock.mockRejectedValue(new UserSuspendedError());

    const response = await placeRoute(
      jsonRequest("http://localhost/api/v1/bids/mission/1", "POST", { amount: 900 }),
      missionContext("1"),
    );

    expect(response.status).toBe(403);
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/bids/mission/1"), { method: "POST" }),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/bids/mission/{missionId}", () => {
  it("returns every bid for the owning designer — the split is the service's, not the route's", async () => {
    listForMissionMock.mockResolvedValue([
      fakeBid({ id: 6, pilot: { id: 43, username: "quinn" }, amount: 1100 }),
      fakeBid(),
    ]);

    const response = await listRoute(
      getRequest("http://localhost/api/v1/bids/mission/1", DESIGNER_ID, "DESIGNER"),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body.map((entry: { pilotName: string }) => entry.pilotName)).toEqual(["quinn", "pia"]);
    expect(listForMissionMock).toHaveBeenCalledWith(1, DESIGNER_ID);
  });

  it("returns only the caller's own bid for a non-owner, on the very same endpoint", async () => {
    listForMissionMock.mockResolvedValue([fakeBid()]);

    const response = await listRoute(
      getRequest("http://localhost/api/v1/bids/mission/1"),
      missionContext("1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ pilotId: PILOT_ID, pilotName: "pia" });
    expect(listForMissionMock).toHaveBeenCalledWith(1, PILOT_ID);
  });

  it("is authenticated-only, not pilot-only: a designer may call it and gets an empty list", async () => {
    listForMissionMock.mockResolvedValue([]);

    const response = await listRoute(
      getRequest("http://localhost/api/v1/bids/mission/1", 99, "DESIGNER"),
      missionContext("1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it("takes the caller id from the verified token headers, never from the query string", async () => {
    listForMissionMock.mockResolvedValue([]);

    await listRoute(
      getRequest("http://localhost/api/v1/bids/mission/1?userId=7"),
      missionContext("1"),
    );

    expect(listForMissionMock).toHaveBeenCalledWith(1, PILOT_ID);
  });

  it("answers 404 for a mission that does not exist", async () => {
    listForMissionMock.mockRejectedValue(new MissionNotFoundError(9));

    const response = await listRoute(
      getRequest("http://localhost/api/v1/bids/mission/9"),
      missionContext("9"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a non-numeric mission id with 400", async () => {
    const response = await listRoute(
      getRequest("http://localhost/api/v1/bids/mission/abc"),
      missionContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ missionId: "must be a number" });
    expect(listForMissionMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/bids/mission/1")),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/bids/my", () => {
  it("returns the calling pilot's bids as a bare BidResponse array", async () => {
    myBidsMock.mockResolvedValue([fakeBid()]);

    const response = await myBidsRoute(getRequest("http://localhost/api/v1/bids/my"), listContext);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: 5,
      missionId: MISSION_ID,
      missionName: "Orchard survey",
      pilotId: PILOT_ID,
      status: "PENDING",
    });
    expect(myBidsMock).toHaveBeenCalledWith(PILOT_ID);
  });

  it("rejects a designer with 403 and lists nothing (hasRole('PILOT'))", async () => {
    const response = await myBidsRoute(
      getRequest("http://localhost/api/v1/bids/my", DESIGNER_ID, "DESIGNER"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(myBidsMock).not.toHaveBeenCalled();
  });

  it("takes the pilot id from the verified token headers, never from the query string", async () => {
    myBidsMock.mockResolvedValue([]);

    await myBidsRoute(getRequest("http://localhost/api/v1/bids/my?userId=99"), listContext);

    expect(myBidsMock).toHaveBeenCalledWith(PILOT_ID);
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(new NextRequest(new URL("http://localhost/api/v1/bids/my")));

    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/v1/bids/{id}", () => {
  it("withdraws the caller's bid and answers 204 with no body", async () => {
    withdrawMock.mockResolvedValue(undefined);

    const response = await withdrawRoute(
      jsonRequest("http://localhost/api/v1/bids/5", "DELETE", undefined),
      idContext("5"),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(withdrawMock).toHaveBeenCalledWith(5, PILOT_ID);
  });

  it("rejects a designer with 403 and withdraws nothing (hasRole('PILOT'))", async () => {
    const response = await withdrawRoute(
      jsonRequest("http://localhost/api/v1/bids/5", "DELETE", undefined, DESIGNER_ID, "DESIGNER"),
      idContext("5"),
    );

    expect(response.status).toBe(403);
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  it("answers 404 — not 403 — for another pilot's bid, so ids cannot be probed", async () => {
    withdrawMock.mockRejectedValue(new BidNotFoundError(5));

    const response = await withdrawRoute(
      jsonRequest("http://localhost/api/v1/bids/5", "DELETE", undefined),
      idContext("5"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ status: "NOT_FOUND", message: "Bid 5 not found" });
  });

  it("answers 409 for a bid that has already been decided", async () => {
    withdrawMock.mockRejectedValue(
      new BidConflictError("Bid 5 has already been decided and cannot be withdrawn"),
    );

    const response = await withdrawRoute(
      jsonRequest("http://localhost/api/v1/bids/5", "DELETE", undefined),
      idContext("5"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.message).toBe("Bid 5 has already been decided and cannot be withdrawn");
  });

  it("rejects a non-numeric bid id with 400", async () => {
    const response = await withdrawRoute(
      jsonRequest("http://localhost/api/v1/bids/abc", "DELETE", undefined),
      idContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.data).toMatchObject({ id: "must be a number" });
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/bids/5"), { method: "DELETE" }),
    );

    expect(response.status).toBe(401);
  });
});
