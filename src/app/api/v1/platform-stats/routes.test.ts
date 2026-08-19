import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MISSION_STATUSES, USER_ROLES, type UserRole } from "@/db/schema";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import type { PlatformStats } from "@/features/stats/stats.types";

/**
 * Route-level suite for `GET /api/v1/platform-stats`.
 *
 * Mirrors `PlatformStatsControllerTest`, a Mockito unit test of the controller
 * rather than a live-database one: `PlatformStatsService` is mocked so the
 * assertions are about what the *web layer* does — that every component of the
 * snapshot lands in the response under the right key, that the top-missions
 * list is carried across, and that the endpoint is admin-only. Same shape as
 * the neighbouring `audit-log/routes.test.ts`, which this file follows.
 *
 * The Java suite's single case is `overviewMapsTheStatsIntoTheResponse`, and
 * what it really pins is `PlatformStatsMapper`. This port has no mapper module
 * (`route.ts` explains why: the service's value already *is* the wire shape),
 * so the equivalent assertion is made on the serialized JSON body — which is
 * strictly more than the Java test checks, since it also proves the numbers
 * survive JSON with no key renamed, dropped or added.
 *
 * The stubbed snapshot reuses the Java test's numbers exactly: 2 PUBLISHED
 * missions, 7 active pilots, 57 bids totalling 12345.50, 3 suspended users, 31
 * pilots, and one top mission ("Orchard survey", 9 bids).
 *
 * One deliberate difference from the Java stub: `Map.of(PUBLISHED, 2L)` there
 * is *sparse*, because a Mockito stub can return any map it likes. Here the
 * maps are zero-filled over every status/role, because that is what the real
 * `overview()` always returns — `PlatformStats` types them as full `Record`s,
 * not `Partial`s, and the zero-filling is the service's job (pinned by
 * `src/features/stats/stats.service.test.ts`). Stubbing a shape the service
 * cannot produce would test the route against fiction.
 *
 * The 401 case goes through `middleware()` itself, the layer that actually
 * rejects an anonymous caller in the deployed app (this path is not in its
 * `PUBLIC_PATHS`), following the precedent of the other route suites. The 403
 * cases call the handler with a verified non-admin's headers, since
 * `requireRole()` is what stands in for `@PreAuthorize("hasRole('ADMIN')")` —
 * cases the Java suite has no counterpart for, since a Mockito unit test of a
 * controller bypasses method security entirely.
 *
 * What this suite cannot show is whether the aggregates are *accurate*: that is
 * `routes.live.test.ts` beside this file, over a seeded fixture.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/controller/stats/PlatformStatsController.java
 * - test .../web/controller/stats/PlatformStatsControllerTest.java
 */

const overviewMock = vi.fn();
vi.mock("@/features/stats/stats.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/stats/stats.service")>();
  return { ...actual, overview: (...args: unknown[]) => overviewMock(...args) };
});

// `vi.mock` is hoisted, so this already resolves against the mocked module.
import { middleware } from "@/middleware";
import { GET as overviewRoute } from "./route";

const ADMIN_ID = 9;

/** The context Next.js hands a non-dynamic route handler. */
const routeContext = { params: Promise.resolve({}) };

/** The headers `src/middleware.ts` attaches from a verified token's claims. */
function request(userId = ADMIN_ID, role: UserRole = "ADMIN"): Request {
  return new Request("http://localhost/api/v1/platform-stats", {
    headers: { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role },
  });
}

/** A count map over a whole union, all zero — what `overview()` starts from. */
function zeroFilled<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

/**
 * The Java test's stubbed `PlatformStats`, zero-filled as the real service
 * returns it (see the header): PUBLISHED 2, PILOT 31, and the rest at zero.
 */
function fakeStats(overrides: Partial<PlatformStats> = {}): PlatformStats {
  return {
    missionsByStatus: { ...zeroFilled(MISSION_STATUSES), PUBLISHED: 2 },
    activePilots: 7,
    bidCount: 57,
    bidAmountTotal: 12345.5,
    suspendedUsers: 3,
    usersByRole: { ...zeroFilled(USER_ROLES), PILOT: 31 },
    topMissionsByBids: [{ name: "Orchard survey", bids: 9 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/platform-stats", () => {
  // Mirrors `overviewMapsTheStatsIntoTheResponse`.
  it("maps the stats into the response", async () => {
    overviewMock.mockResolvedValue(fakeStats());

    const response = await overviewRoute(request(), routeContext);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(overviewMock).toHaveBeenCalledWith();
    expect(body.missionsByStatus).toMatchObject({ PUBLISHED: 2 });
    expect(body.activePilots).toBe(7);
    expect(body.bidCount).toBe(57);
    expect(body.bidAmountTotal).toBe(12345.5);
    expect(body.suspendedUsers).toBe(3);
    expect(body.usersByRole).toMatchObject({ PILOT: 31 });
    expect(body.topMissionsByBids).toEqual([{ name: "Orchard survey", bids: 9 }]);
  });

  /**
   * The full `PlatformStatsResponse` shape, field for field — the Angular
   * `PlatformStats` interface (ported to `stats.client.ts`) is typed against
   * exactly these seven keys, both maps arrive complete, and nothing the
   * service holds leaks in beside them.
   */
  it("answers the PlatformStats shape and nothing more", async () => {
    overviewMock.mockResolvedValue(fakeStats());

    const response = await overviewRoute(request(), routeContext);
    const body = await response.json();

    expect(body).toEqual({
      missionsByStatus: {
        DRAFT: 0,
        PUBLISHED: 2,
        BIDDING: 0,
        AWARDED: 0,
        IN_PROGRESS: 0,
        COMPLETED: 0,
        CANCELLED: 0,
      },
      activePilots: 7,
      bidCount: 57,
      bidAmountTotal: 12345.5,
      suspendedUsers: 3,
      usersByRole: { DESIGNER: 0, PILOT: 31, ADMIN: 0 },
      topMissionsByBids: [{ name: "Orchard survey", bids: 9 }],
    });
  });

  /**
   * `bidAmountTotal` is an unquoted JSON **number**, not the decimal string
   * postgres.js hands back for `sum(numeric)` — Jackson serializes the source's
   * `BigDecimal` as a number, and the Angular chart does arithmetic on it. The
   * narrowing happens once, in `volume()`; this asserts nothing re-widens it on
   * the way out.
   */
  it("serializes bidAmountTotal as a JSON number", async () => {
    overviewMock.mockResolvedValue(fakeStats());

    const response = await overviewRoute(request(), routeContext);
    const text = await response.text();

    expect(text).toContain('"bidAmountTotal":12345.5');
    expect(JSON.parse(text).bidAmountTotal).toBeTypeOf("number");
  });

  /** An empty platform is a 200 of zeros, never a 404 or an error state. */
  it("answers 200 with zeros on an empty platform", async () => {
    overviewMock.mockResolvedValue(
      fakeStats({
        missionsByStatus: zeroFilled(MISSION_STATUSES),
        activePilots: 0,
        bidCount: 0,
        bidAmountTotal: 0,
        suspendedUsers: 0,
        usersByRole: zeroFilled(USER_ROLES),
        topMissionsByBids: [],
      }),
    );

    const response = await overviewRoute(request(), routeContext);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bidAmountTotal).toBe(0);
    expect(body.topMissionsByBids).toEqual([]);
    expect(body.missionsByStatus.PUBLISHED).toBe(0);
  });

  it("rejects a designer with 403 and never reaches the service", async () => {
    const response = await overviewRoute(request(7, "DESIGNER"), routeContext);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      data: null,
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("rejects a pilot with 403 and never reaches the service", async () => {
    const response = await overviewRoute(request(3, "PILOT"), routeContext);

    expect(response.status).toBe(403);
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/platform-stats")),
    );
    expect(response.status).toBe(401);
  });
});
