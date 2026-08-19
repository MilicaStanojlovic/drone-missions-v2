import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, bid, mission, notification, users } from "@/db/schema";
import { MISSION_STATUSES, USER_ROLES } from "@/db/schema";
import type { MissionStatus, UserRole } from "@/db/schema";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import type { PlatformStats } from "@/features/stats/stats.types";
import { POST as registerRoute } from "../auth/register/route";
import { POST as createMissionRoute } from "../missions/route";
import { POST as hideRoute } from "../missions/[id]/hide/route";
import { POST as placeBidRoute } from "../bids/mission/[missionId]/route";
import { POST as suspendRoute } from "../users/[id]/suspend/route";
import { GET as overviewRoute } from "./route";

/**
 * Route-level **integration** suite for `GET /api/v1/platform-stats`: the real
 * handler over the real `overview()`, the real bid/user/mission aggregates, the
 * real caching mission DAO and a real Postgres, with nothing mocked.
 *
 * This is the live-DB counterpart of `routes.test.ts`, which mocks the stats
 * service exactly as `PlatformStatsControllerTest` mocks its
 * `PlatformStatsService` and therefore proves only that a *stubbed* snapshot
 * survives serialization. The one thing that suite explicitly cannot show is
 * the thing the dashboard is for — whether the numbers are **accurate** — and
 * that is what this file exists to pin, over a fixture seeded through the same
 * endpoints a user would drive:
 *
 * - the status map counting real `mission.status` rows, zero-filled over every
 *   status, and counting missions the marketplace hides: a HIDDEN mission and a
 *   suspended designer's missions both still appear here, because the overview
 *   is an admin census and not a feed (the same reason `topMissionsByBids` has
 *   no moderation filter);
 * - `activePilots` excluding the suspended pilot while `usersByRole.PILOT`
 *   still counts them — the two counts differ by exactly the suspension, which
 *   is the whole reason the source has both;
 * - `suspendedUsers` spanning roles (a suspended designer counts too, and does
 *   not touch `activePilots`);
 * - `bidCount`/`bidAmountTotal` over dozens of real bids placed through
 *   `POST /bids/mission/{id}`, with `bidAmountTotal` arriving as a JSON
 *   **number** to the cent — the postgres.js `sum(numeric)` narrowing that
 *   `volume()` performs, end to end;
 * - the chart: seven seeded missions with strictly descending bid counts, of
 *   which exactly the top six come back, in order, the seventh cut by the cap.
 *
 * ## Why the assertions are written as `foreign + fixture`
 *
 * Every number this endpoint returns is a *platform-wide* aggregate, so unlike
 * the neighbouring live suites this one cannot scope its assertions to its own
 * rows with a `runId`: whatever else the database holds is inside every count.
 * The suite therefore measures the rest of the database directly — the same
 * aggregates, over exactly the rows that are **not** this fixture's — and
 * asserts the endpoint reports that plus the fixture, to the unit. Nothing is
 * approximate and nothing is skipped; the fixture's own contribution is
 * asserted exactly, which is what "accurate aggregates" has to mean on a shared
 * database.
 *
 * That measurement is taken *twice*, bracketing the request, and repeated if it
 * moved (`stableOverview` below). Vitest runs test files in parallel, so the
 * other live suites are inserting users, missions and bids the whole time; the
 * bracket is what turns "a foreign row landed mid-read" from a flaky failure
 * into a retry.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * The 401 case is not repeated here — anonymous rejection happens in
 * `src/middleware.ts`, above every handler and below no database, and
 * `routes.test.ts` drives the real middleware for exactly that.
 *
 * There is no Spring counterpart to mirror: the backend has no
 * `@SpringBootTest` integration suite (`PlatformStatsServiceTest` is a Mockito
 * unit test, mirrored in `stats.service.test.ts`). Each case names the rule it
 * pins instead.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../web/controller/stats/PlatformStatsController.java
 * - drone-missions-backend/.../business/service/stats/PlatformStatsService.java
 * - drone-missions-backend/.../data/repository/BidRepository.java (`volume`, `topMissionsByBids`)
 * - drone-missions-backend/.../data/repository/UserRepository.java (the three counts)
 * - drone-missions-backend/.../data/repository/MissionRepository.java (`countByStatus`)
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/** The chart's cap, as `stats.service.ts` sets it. */
const TOP_MISSIONS = 6;
/** One more than the cap, so the seventh bar proves the cut. */
const CHART_MISSIONS = 7;
/**
 * How far above the busiest *foreign* mission the fixture's quietest charted
 * mission sits. The chart is global, so the fixture can only own the top six by
 * out-bidding everything else in the database; the headroom absorbs a
 * concurrently running suite placing a few bids of its own after this one has
 * sized itself.
 */
const HEADROOM = 3;
/** No row has this id, so `notInArray` is never handed an empty list. */
const SENTINEL = -1;

/** The rest of the database, measured exactly as the endpoint measures it. */
interface ForeignAggregates {
  missionsByStatus: Record<MissionStatus, number>;
  usersByRole: Record<UserRole, number>;
  activePilots: number;
  suspendedUsers: number;
  bidCount: number;
  /** Integer cents — a decimal total compared as an integer never drifts. */
  bidAmountCents: number;
  /** The largest per-mission bid count outside the fixture (0 if none). */
  topMissionBids: number;
}

describe.runIf(hasDb)("GET /api/v1/platform-stats (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();
  let emailCounter = 0;

  function uniqueEmail(label: string): string {
    emailCounter += 1;
    return `stats-route-${runId}-${emailCounter}-${label}@example.com`;
  }

  const listContext = { params: Promise.resolve({}) };
  /** Every row this suite created — the exclusion set, and the cleanup set. */
  const insertedUserIds: number[] = [];
  const insertedMissionIds: number[] = [];

  function idContext(id: number | string) {
    return { params: Promise.resolve({ id: String(id) }) };
  }

  function missionContext(missionId: number | string) {
    return { params: Promise.resolve({ missionId: String(missionId) }) };
  }

  /** The headers `src/middleware.ts` attaches from a verified token's claims. */
  function authHeaders(userId: number, role: UserRole): Record<string, string> {
    return { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role };
  }

  function getRequest(url: string, userId: number, role: UserRole): Request {
    return new Request(url, { headers: authHeaders(userId, role) });
  }

  function postRequest(url: string, userId: number, role: UserRole): Request {
    return new Request(url, { method: "POST", headers: authHeaders(userId, role) });
  }

  function jsonRequest(url: string, body: unknown, userId: number, role: UserRole): Request {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(userId, role) },
      body: JSON.stringify(body),
    });
  }

  /** Registers a marketplace account through the real endpoint. */
  async function registerTestUser(role: "DESIGNER" | "PILOT", label: string): Promise<number> {
    const response = await registerRoute(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: `stats-${label}-${emailCounter + 1}`,
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
   * Seeds an ADMIN directly. `/api/v1/auth/register` refuses the role by
   * design, and this suite needs one to call the endpoint at all — the same
   * bootstrap the V12 seed migration performs in a deployment.
   */
  async function seedAdmin(label: string): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `stats-${label}`,
        email: uniqueEmail(label),
        // A literal, obviously-not-a-hash placeholder: this account never logs
        // in (the handlers read a verified principal off the headers), and the
        // column is only NOT NULL.
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

  /** An ISO instant for a *local* wall-clock time (see the missions live suite). */
  function localInstant(year: number, month: number, day: number, hour: number): string {
    return new Date(year, month - 1, day, hour).toISOString();
  }

  /**
   * Creates one mission through the real endpoint, in the status asked for.
   *
   * `missionRequestSchema` accepts every `MissionStatus` and `MissionService.create`
   * writes it through untouched, so the census fixture needs no hand-written
   * rows: a COMPLETED or CANCELLED mission is one POST, not a status column
   * poked behind the service's back.
   */
  async function createMission(
    designerId: number,
    status: MissionStatus,
    label: string,
  ): Promise<{ id: number; name: string }> {
    const response = await createMissionRoute(
      jsonRequest(
        "http://localhost/api/v1/missions",
        {
          name: `Stats ${label} ${runId}`,
          description: `Platform-stats fixture ${label} ${runId}`,
          status,
          startTime: localInstant(2030, 9, 1, 8),
          endTime: localInstant(2030, 9, 1, 10),
          location: `Novi Sad ${runId}`,
          // Far enough out that the bidding-deadline rule never fires.
          biddingDeadline: "2030-08-25",
          // `@Size(min = 2)` — the shortest flight path the validator allows.
          waypoints: [
            { lat: 45.2671, lng: 19.8335, altitude: 60, action: "PHOTO" },
            { lat: 45.2681, lng: 19.8345, altitude: 80, action: "PHOTO" },
          ],
        },
        designerId,
        "DESIGNER",
      ),
      listContext,
    );
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.status).toBe(status);
    insertedMissionIds.push(body.id);
    return { id: body.id as number, name: body.name as string };
  }

  /**
   * The same aggregates the endpoint computes, over every row that is **not**
   * this fixture's. The maps are zero-filled over the whole union so the
   * arithmetic below never has to reason about an absent key — and so two
   * readings serialize identically regardless of the order Postgres returned
   * the groups in.
   */
  async function foreignAggregates(): Promise<ForeignAggregates> {
    const db = getDb();
    const otherUsers = notInArray(users.id, [...insertedUserIds, SENTINEL]);
    const otherMissions = notInArray(mission.id, [...insertedMissionIds, SENTINEL]);
    // Excluding the fixture's missions is enough to exclude the fixture's bids:
    // its pilots only ever bid on its own missions, and no other suite knows
    // these mission ids exist.
    const otherBids = notInArray(bid.missionId, [...insertedMissionIds, SENTINEL]);

    const statusRows = await db
      .select({ status: mission.status, total: count() })
      .from(mission)
      .where(otherMissions)
      .groupBy(mission.status);
    const roleRows = await db
      .select({ role: users.role, total: count() })
      .from(users)
      .where(otherUsers)
      .groupBy(users.role);
    const [activeRow] = await db
      .select({ value: count() })
      .from(users)
      .where(and(otherUsers, eq(users.role, "PILOT"), eq(users.suspended, false)));
    const [suspendedRow] = await db
      .select({ value: count() })
      .from(users)
      .where(and(otherUsers, eq(users.suspended, true)));
    const [volumeRow] = await db
      .select({
        total: count(),
        // Summed in cents rather than in the column's own decimal text: an
        // integer crosses into JavaScript without a rounding question.
        cents: sql<string>`coalesce(sum(round(${bid.amount} * 100)), 0)`,
      })
      .from(bid)
      .where(otherBids);
    const [topRow] = await db
      .select({ total: count() })
      .from(bid)
      .where(otherBids)
      .groupBy(bid.missionId)
      .orderBy(desc(count()))
      .limit(1);

    const missionsByStatus = zeroFilled(MISSION_STATUSES);
    for (const row of statusRows) {
      missionsByStatus[row.status] = row.total;
    }
    const usersByRole = zeroFilled(USER_ROLES);
    for (const row of roleRows) {
      usersByRole[row.role] = row.total;
    }

    return {
      missionsByStatus,
      usersByRole,
      activePilots: activeRow?.value ?? 0,
      suspendedUsers: suspendedRow?.value ?? 0,
      bidCount: volumeRow?.total ?? 0,
      bidAmountCents: Number(volumeRow?.cents ?? 0),
      topMissionBids: topRow?.total ?? 0,
    };
  }

  /** A count map over a whole union, all zero. */
  function zeroFilled<K extends string>(keys: readonly K[]): Record<K, number> {
    return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  }

  /**
   * Reads the endpoint with a measurement of the rest of the database taken on
   * either side of the request, and keeps the pair only if the two readings
   * agree — i.e. only if nothing outside this fixture changed while the
   * snapshot was being taken.
   *
   * Vitest runs test files in parallel and every other live suite writes users,
   * missions and bids, so without this bracket an exact assertion would be a
   * coin toss. With it, a concurrent write costs a retry instead of a failure;
   * the fixture itself is frozen by then, so a retry re-reads the same numbers.
   */
  async function stableOverview(): Promise<{ stats: PlatformStats; foreign: ForeignAggregates }> {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const before = await foreignAggregates();
      const response = await overviewRoute(
        getRequest("http://localhost/api/v1/platform-stats", adminId, "ADMIN"),
        listContext,
      );
      expect(response.status).toBe(200);
      const stats = (await response.json()) as PlatformStats;
      const after = await foreignAggregates();
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { stats, foreign: before };
      }
    }
    throw new Error(
      "the rest of the database kept changing across five attempts — no stable snapshot to assert against",
    );
  }

  let adminId: number;
  let designerId: number;
  /** Suspended once its missions exist, to prove they still get counted. */
  let suspendedDesignerId: number;
  const pilotIds: number[] = [];
  /** Suspended after every bid is in, to prove `activePilots` drops it. */
  let suspendedPilotId: number;
  /** Charted missions, busiest first, with the bid count each one carries. */
  const chartMissions: { id: number; name: string; bids: number }[] = [];
  /** The one HIDDEN mission — a PUBLISHED row the census must still count. */
  let hiddenMissionId: number;

  /** Missions created directly in each status, before any bid flips one. */
  const SEEDED_STATUSES: MissionStatus[] = [
    "DRAFT",
    "PUBLISHED",
    "PUBLISHED",
    "AWARDED",
    "AWARDED",
    "AWARDED",
    "IN_PROGRESS",
    "COMPLETED",
    "COMPLETED",
    "CANCELLED",
  ];

  /**
   * What the fixture adds to `missionsByStatus`: the statuses seeded above,
   * plus the charted missions — created PUBLISHED and flipped to BIDDING by
   * their first bid, exactly as `BidService.place` does it in production.
   */
  const fixtureMissionsByStatus = zeroFilled(MISSION_STATUSES);
  for (const status of SEEDED_STATUSES) {
    fixtureMissionsByStatus[status] += 1;
  }
  fixtureMissionsByStatus.BIDDING += CHART_MISSIONS;

  /** Bids the fixture placed, and their exact total in cents. */
  let fixtureBidCount = 0;
  let fixtureBidCents = 0;

  beforeAll(async () => {
    adminId = await seedAdmin("admin");
    designerId = await registerTestUser("DESIGNER", "designer");
    suspendedDesignerId = await registerTestUser("DESIGNER", "designer-suspended");

    // Size the chart so the fixture owns all six bars: its quietest charted
    // mission still out-bids the busiest mission in the rest of the database.
    const busiestElsewhere = (await foreignAggregates()).topMissionBids;
    const bidsFor = (index: number) => busiestElsewhere + HEADROOM + CHART_MISSIONS - index;
    const pilotsNeeded = bidsFor(0);

    for (let index = 0; index < pilotsNeeded; index += 1) {
      pilotIds.push(await registerTestUser("PILOT", `pilot-${index}`));
    }
    suspendedPilotId = pilotIds[0];

    // The census fixture: one mission per seeded status, the last two owned by
    // the designer who is about to be suspended.
    const seeded: number[] = [];
    for (const [index, status] of SEEDED_STATUSES.entries()) {
      const owner = index >= SEEDED_STATUSES.length - 2 ? suspendedDesignerId : designerId;
      seeded.push((await createMission(owner, status, `${status.toLowerCase()}-${index}`)).id);
    }

    // Hide the first PUBLISHED one: moderation is not status, and the overview
    // counts the mission either way.
    hiddenMissionId = seeded[SEEDED_STATUSES.indexOf("PUBLISHED")];
    const hidden = await hideRoute(
      postRequest(`http://localhost/api/v1/missions/${hiddenMissionId}/hide`, adminId, "ADMIN"),
      idContext(hiddenMissionId),
    );
    expect(hidden.status).toBe(200);

    // The chart: seven PUBLISHED missions bid on through the real endpoint,
    // strictly descending in bid count so the ordering has one right answer.
    for (let index = 0; index < CHART_MISSIONS; index += 1) {
      const bids = bidsFor(index);
      const { id, name } = await createMission(designerId, "PUBLISHED", `chart-${index}`);
      for (let pilot = 0; pilot < bids; pilot += 1) {
        // Distinct to the cent, so a total that happens to be right cannot be
        // right by symmetry.
        const cents = 10_000 + index * 1_000 + pilot * 5;
        const response = await placeBidRoute(
          jsonRequest(
            `http://localhost/api/v1/bids/mission/${id}`,
            { amount: cents / 100, message: null },
            pilotIds[pilot],
            "PILOT",
          ),
          missionContext(id),
        );
        expect(response.status).toBe(200);
        fixtureBidCount += 1;
        fixtureBidCents += cents;
      }
      chartMissions.push({ id, name, bids });
    }

    // Suspensions last: a suspended pilot cannot bid and a suspended designer
    // cannot create, so both would have blocked the seeding above.
    for (const target of [suspendedPilotId, suspendedDesignerId]) {
      const response = await suspendRoute(
        postRequest(`http://localhost/api/v1/users/${target}/suspend`, adminId, "ADMIN"),
        idContext(target),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).suspended).toBe(true);
    }
  });

  afterAll(async () => {
    if (insertedMissionIds.length > 0) {
      // Bids first (`fk_bid_mission` is the fixture's only dependent), then the
      // missions themselves.
      await getDb().delete(bid).where(inArray(bid.missionId, insertedMissionIds));
      await getDb().delete(mission).where(inArray(mission.id, insertedMissionIds));
    }
    if (insertedUserIds.length > 0) {
      await getDb().delete(notification).where(inArray(notification.userId, insertedUserIds));
      // Audit rows deliberately outlive their actor (see `audit_log`'s doc
      // comment in db/schema.ts), so they have to go explicitly.
      await getDb().delete(auditLog).where(inArray(auditLog.actorId, insertedUserIds));
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  /**
   * One fixture, one snapshot, several tiles: the cases below all read the same
   * response. Re-reading per case would widen the window a concurrent writer
   * has to disturb, and would say nothing extra — every tile comes off the same
   * `overview()` call in production too.
   */
  let stats: PlatformStats;
  let foreign: ForeignAggregates;

  beforeAll(async () => {
    ({ stats, foreign } = await stableOverview());
  });

  it("answers with the whole snapshot and nothing else", () => {
    expect(Object.keys(stats).sort()).toEqual([
      "activePilots",
      "bidAmountTotal",
      "bidCount",
      "missionsByStatus",
      "suspendedUsers",
      "topMissionsByBids",
      "usersByRole",
    ]);
  });

  it("counts every mission status exactly, zero-filled over the whole union", () => {
    const expected = { ...foreign.missionsByStatus };
    for (const status of MISSION_STATUSES) {
      expected[status] += fixtureMissionsByStatus[status];
    }

    expect(stats.missionsByStatus).toEqual(expected);
    // Every status is present — a status no mission holds reads 0 rather than
    // going missing, which is what lets the dashboard index the map without a
    // fallback. The key order is the union's declaration order, the port of the
    // source's `EnumMap`.
    expect(Object.keys(stats.missionsByStatus)).toEqual(MISSION_STATUSES);
    // The seven charted missions were created PUBLISHED and are BIDDING now:
    // the census sees the state the bids left behind, not the state they were
    // created in.
    expect(stats.missionsByStatus.BIDDING).toBe(foreign.missionsByStatus.BIDDING + CHART_MISSIONS);
  });

  it("counts a hidden mission and a suspended designer's missions like any other", async () => {
    const [hidden] = await getDb().select().from(mission).where(eq(mission.id, hiddenMissionId));
    expect(hidden.moderation).toBe("HIDDEN");
    expect(hidden.status).toBe("PUBLISHED");

    const orphaned = await getDb()
      .select({ id: mission.id })
      .from(mission)
      .where(eq(mission.userId, suspendedDesignerId));
    expect(orphaned).toHaveLength(2);

    // Both are inside the totals asserted above — this is the census of the
    // platform, not the marketplace feed, so moderation and suspension change
    // what is *visible*, never what is *counted*. Restating the two statuses
    // makes the claim explicit rather than implied by the map equality.
    expect(stats.missionsByStatus.PUBLISHED).toBe(foreign.missionsByStatus.PUBLISHED + 2);
    expect(stats.missionsByStatus.COMPLETED).toBe(foreign.missionsByStatus.COMPLETED + 2);
  });

  it("counts active pilots without the suspended one, and suspensions across roles", async () => {
    const [pilot] = await getDb().select().from(users).where(eq(users.id, suspendedPilotId));
    expect(pilot.suspended).toBe(true);

    // `countByRoleAndSuspendedFalse('PILOT')`: every pilot the fixture
    // registered except the suspended one.
    expect(stats.activePilots).toBe(foreign.activePilots + pilotIds.length - 1);
    // ...while the role census still counts them — the two tiles differ by
    // exactly the suspension, which is why the source computes both.
    expect(stats.usersByRole.PILOT).toBe(foreign.usersByRole.PILOT + pilotIds.length);
    // `countBySuspendedTrue()` has no role predicate: the suspended designer
    // counts here and nowhere near `activePilots`.
    expect(stats.suspendedUsers).toBe(foreign.suspendedUsers + 2);
  });

  it("counts every account by role, zero-filled over the whole union", () => {
    expect(stats.usersByRole).toEqual({
      DESIGNER: foreign.usersByRole.DESIGNER + 2,
      PILOT: foreign.usersByRole.PILOT + pilotIds.length,
      ADMIN: foreign.usersByRole.ADMIN + 1,
    });
    expect(Object.keys(stats.usersByRole)).toEqual(USER_ROLES);
  });

  it("adds up every bid and its amount to the cent, as a JSON number", () => {
    expect(stats.bidCount).toBe(foreign.bidCount + fixtureBidCount);
    // `bidAmountTotal` is a number, not the decimal *text* postgres.js hands
    // back for `sum(numeric)`: Jackson writes the source's BigDecimal as an
    // unquoted number, and `volume()` narrows it once so this matches.
    expect(typeof stats.bidAmountTotal).toBe("number");
    expect(Math.round(stats.bidAmountTotal * 100)).toBe(foreign.bidAmountCents + fixtureBidCents);
    // The suspended pilot's bids are still in there: `volume()` counts bids,
    // not bidders, and suspending someone does not rewrite history.
    expect(fixtureBidCount).toBeGreaterThan(0);
  });

  it("charts the six most-bid-on missions, ordered, and cuts the seventh", () => {
    const expected = chartMissions.slice(0, TOP_MISSIONS);

    expect(stats.topMissionsByBids).toHaveLength(TOP_MISSIONS);
    expect(stats.topMissionsByBids).toEqual(
      expected.map((entry) => ({ name: entry.name, bids: entry.bids })),
    );
    // Ordered by bid count, descending — restated independently of the fixture
    // so the ordering rule is pinned by the response's own shape.
    const counts = stats.topMissionsByBids.map((entry) => entry.bids);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    // The seventh mission is real, and has bids, and is still not on the chart:
    // `TOP_MISSIONS = 6` is a cap, not a coincidence of the fixture.
    const cut = chartMissions[CHART_MISSIONS - 1];
    expect(cut.bids).toBeGreaterThan(0);
    expect(stats.topMissionsByBids.map((entry) => entry.name)).not.toContain(cut.name);
    // Zero-bid missions never appear at all — the count is over bid rows.
    expect(stats.topMissionsByBids.every((entry) => entry.bids > 0)).toBe(true);
  });

  it("refuses a designer and a pilot with 403 over real rows", async () => {
    for (const [id, role] of [
      [designerId, "DESIGNER"],
      [pilotIds[1], "PILOT"],
    ] as const) {
      const response = await overviewRoute(
        getRequest("http://localhost/api/v1/platform-stats", id, role),
        listContext,
      );
      expect(response.status).toBe(403);
      expect((await response.json()).status).toBe("FORBIDDEN");
    }
  });
});

describe.skipIf(hasDb)("GET /api/v1/platform-stats (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
