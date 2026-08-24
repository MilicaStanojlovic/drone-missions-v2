import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, mission, users } from "@/db/schema";
import type { UserRole } from "@/db/schema";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import { POST as registerRoute } from "@/app/api/v1/auth/register/route";
import { POST as createMissionRoute } from "@/app/api/v1/missions/route";
import { POST as hideRoute } from "@/app/api/v1/missions/[id]/hide/route";
import { POST as suspendRoute } from "@/app/api/v1/users/[id]/suspend/route";
import { GET as auditLogRoute } from "@/app/api/v1/audit-log/route";

/**
 * Route-level **integration** suite for `GET /api/v1/audit-log`: the real
 * handler over the real `AuditService`, the real query and a real Postgres,
 * with nothing mocked.
 *
 * This is the live-DB counterpart of `routes.test.ts`, which mocks the service
 * exactly as `AuditLogControllerTest` does and therefore proves only what the
 * web layer contributes. What it cannot prove — and what this file exists for —
 * is that the trail *round-trips*: the rows the endpoint lists are written here
 * by the very actions that produce them in production (a registration, a
 * mission creation, an admin hide, an admin suspension), read back through the
 * real filters, and mapped into the wire shape the Angular table renders.
 *
 * That end-to-end path is the point. The audit log is the one read in the app
 * whose input is entirely other endpoints' side effects, so a mocked suite can
 * only ever assert that a stubbed page was wrapped correctly; whether an
 * `ADMIN`-actored row really carries the acting admin's id, whether its
 * `details` really is the quoted mission name a `?q` search will match, and
 * whether the actor's username joins back on, are all facts about the database.
 *
 * The filter *combinations* and the SQL rules beneath them (the two-LIKEs-OR'd
 * text match, the `id DESC` tiebreaker, the count carrying the join) are pinned
 * one level down, in `tests/features/audit/server/audit.queries.test.ts`; this file
 * checks the endpoint's own contract on top of them.
 *
 * The 401 case is not repeated here — anonymous rejection happens in
 * `src/middleware.ts`, above every handler and below no database, and
 * `routes.test.ts` drives the real middleware for exactly that.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * There is no Spring counterpart to mirror: the backend has no
 * `@SpringBootTest` integration suite. Each case names the rule it pins.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../web/controller/audit/AuditLogController.java
 * - drone-missions-backend/.../business/service/audit/AuditService.java (`search`)
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("GET /api/v1/audit-log (live DB)", () => {
  /**
   * Unique per run *and* lowercase: it travels into usernames and mission
   * names, and comes back through a `lower(col) LIKE` match.
   */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();
  let emailCounter = 0;

  function uniqueEmail(label: string): string {
    emailCounter += 1;
    return `audit-route-${runId}-${emailCounter}-${label}@example.com`;
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
  async function registerTestUser(
    role: "DESIGNER" | "PILOT",
    username: string,
    label: string,
  ): Promise<number> {
    const response = await registerRoute(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, email: uniqueEmail(label), password: "password123", role }),
      }),
      listContext,
    );
    const body = await response.json();
    expect(response.status).toBe(201);
    insertedUserIds.push(body.id);
    return body.id as number;
  }

  /** Seeds an ADMIN directly — `/auth/register` refuses the role by design. */
  async function seedAdmin(): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        // Deliberately free of the run id: the `?q` cases below must match
        // through `details`, not through this actor's name.
        username: "audit-route-admin",
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

  /** One page of the endpoint, as the admin table fetches it. */
  async function list(query: string, userId = adminId, role: UserRole = "ADMIN") {
    const response = await auditLogRoute(
      getRequest(`http://localhost/api/v1/audit-log${query}`, userId, role),
      listContext,
    );
    return { response, body: await response.json() };
  }

  /** The `action` of every row on a page, in order. */
  function actionsOf(body: { content: { action: string }[] }): string[] {
    return body.content.map((entry) => entry.action);
  }

  let adminId: number;
  let designerId: number;
  let targetId: number;
  let missionId: number;

  const targetUsername = `audit-target-${runId}`;
  const missionName = `Audited Mission ${runId}`;

  beforeAll(async () => {
    adminId = await seedAdmin();
    // The designer's own name carries no run id, so their registration row is
    // not part of the four the `?q` search below must find.
    designerId = await registerTestUser("DESIGNER", "audit-route-designer", "designer");
    // ...whereas the moderation target's does, which is what makes its
    // USER_REGISTERED and USER_SUSPENDED rows part of the expected set.
    targetId = await registerTestUser("PILOT", targetUsername, "target");

    const created = await createMissionRoute(
      jsonRequest(
        "http://localhost/api/v1/missions",
        {
          name: missionName,
          description: `Audit route fixture ${runId}`,
          status: "PUBLISHED",
          startTime: new Date(2030, 8, 1, 8).toISOString(),
          endTime: new Date(2030, 8, 1, 10).toISOString(),
          location: `Novi Sad ${runId}`,
          biddingDeadline: "2030-08-25",
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
    expect(created.status).toBe(201);
    missionId = (await created.json()).id as number;

    expect(
      (
        await hideRoute(
          postRequest(`http://localhost/api/v1/missions/${missionId}/hide`, adminId, "ADMIN"),
          idContext(missionId),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await suspendRoute(
          postRequest(`http://localhost/api/v1/users/${targetId}/suspend`, adminId, "ADMIN"),
          idContext(targetId),
        )
      ).status,
    ).toBe(200);
  });

  afterAll(async () => {
    if (insertedUserIds.length > 0) {
      await getDb().delete(mission).where(inArray(mission.userId, insertedUserIds));
      // Audit rows deliberately outlive their actor (see `audit_log`'s doc
      // comment in db/schema.ts), so they have to go explicitly.
      await getDb().delete(auditLog).where(inArray(auditLog.actorId, insertedUserIds));
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  it("lists the rows those four actions really left, newest first, in the paged envelope", async () => {
    const { response, body } = await list(`?q=${encodeURIComponent(runId)}`);

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["content", "page"]);
    expect(body.page).toMatchObject({ size: 20, number: 0, totalElements: 4, totalPages: 1 });
    // The registration, the creation, the hide and the suspension — the exact
    // trail the four calls in `beforeAll` produced, newest first.
    expect(actionsOf(body)).toEqual([
      "USER_SUSPENDED",
      "MISSION_HIDDEN",
      "MISSION_CREATED",
      "USER_REGISTERED",
    ]);
  });

  it("maps each row into the wire shape, with the actor's username joined back on", async () => {
    const { body } = await list(`?q=${encodeURIComponent(runId)}`);
    const [suspended, hidden] = body.content;

    expect(Object.keys(suspended).sort()).toEqual([
      "action",
      "actorId",
      "actorRole",
      "actorUsername",
      "createdAt",
      "details",
      "id",
      "targetId",
      "targetType",
    ]);
    expect(suspended).toMatchObject({
      // The acting admin, off the verified headers — not the target.
      actorId: adminId,
      actorUsername: "audit-route-admin",
      actorRole: "ADMIN",
      action: "USER_SUSPENDED",
      targetType: "USER",
      targetId: targetId,
      details: `"${targetUsername}"`,
    });
    expect(hidden).toMatchObject({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "MISSION_HIDDEN",
      targetType: "MISSION",
      targetId: missionId,
      details: `"${missionName}"`,
    });
    // An `Instant` crosses the wire as an ISO-8601 string, as Jackson serializes it.
    expect(typeof suspended.createdAt).toBe("string");
    expect(new Date(suspended.createdAt).getTime()).not.toBeNaN();
  });

  it("matches `?q` case-insensitively against the details a mutation wrote", async () => {
    // The mission name is mixed-case in the row; the service lowercases the
    // pattern and the query lowercases the column, so an all-caps search finds it.
    const { body } = await list(`?q=${encodeURIComponent(`AUDITED MISSION ${runId}`)}`);

    expect(actionsOf(body)).toEqual(["MISSION_HIDDEN", "MISSION_CREATED"]);
    expect(body.page.totalElements).toBe(2);
  });

  it("narrows by actor, action and snapshotted role, combining them with AND", async () => {
    const q = encodeURIComponent(runId);

    const byActor = await list(`?q=${q}&actorId=${adminId}`);
    expect(actionsOf(byActor.body)).toEqual(["USER_SUSPENDED", "MISSION_HIDDEN"]);

    const byAction = await list(`?q=${q}&action=MISSION_CREATED`);
    expect(byAction.body.content).toHaveLength(1);
    expect(byAction.body.content[0].actorId).toBe(designerId);

    // `?role` filters on the role the row snapshotted, not the account's
    // current one — which for the pilot's own registration row is PILOT.
    const byRole = await list(`?q=${q}&role=PILOT`);
    expect(actionsOf(byRole.body)).toEqual(["USER_REGISTERED"]);

    // One mismatching member empties the result.
    const impossible = await list(`?q=${q}&actorId=${adminId}&role=DESIGNER`);
    expect(impossible.body.content).toEqual([]);
    expect(impossible.body.page.totalElements).toBe(0);
  });

  it("treats a blank `q` as no filter at all", async () => {
    // `q == null || q.isBlank() ? null : …` — whitespace-only is blank, so this
    // must be the same listing as no `q` whatsoever, not an empty one. Both
    // calls are pinned to this run's admin, whose whole trail is the hide and
    // the suspension `beforeAll` performed (it was seeded, not registered, so
    // it has no USER_REGISTERED row of its own). `actorId` is the one filter
    // that can bound the comparison without going through the `q` this case is
    // about: comparing two *unscoped* totals across two requests would compare
    // two `count(*)`s over the whole `audit_log`, which every other live suite
    // writes to and cleans up from while this one runs.
    const unfiltered = await list(`?actorId=${adminId}`);
    const blank = await list(`?q=%20%20&actorId=${adminId}`);

    expect(blank.response.status).toBe(200);
    expect(actionsOf(unfiltered.body)).toEqual(["USER_SUSPENDED", "MISSION_HIDDEN"]);
    // Identical rows, not merely an identical count: a `q` that survived as a
    // literal `%  %` pattern would match none of them.
    expect(actionsOf(blank.body)).toEqual(actionsOf(unfiltered.body));
    expect(blank.body.page.totalElements).toBe(unfiltered.body.page.totalElements);
  });

  it("slices the trail into pages the client can walk", async () => {
    const q = encodeURIComponent(runId);
    const first = await list(`?q=${q}&size=2`);
    const second = await list(`?q=${q}&size=2&page=1`);

    expect(first.body.page).toMatchObject({ size: 2, number: 0, totalElements: 4, totalPages: 2 });
    expect(actionsOf(first.body)).toEqual(["USER_SUSPENDED", "MISSION_HIDDEN"]);
    expect(second.body.page).toMatchObject({ size: 2, number: 1, totalElements: 4 });
    expect(actionsOf(second.body)).toEqual(["MISSION_CREATED", "USER_REGISTERED"]);
  });

  it("rejects an unparseable filter with 400, whoever asks", async () => {
    expect((await list("?action=nonsense")).response.status).toBe(400);
    expect((await list("?actorId=abc")).response.status).toBe(400);
    // Parsed before the role check, as in the source: a designer sending a bad
    // parameter sees the same 400 an admin would.
    expect((await list("?action=nonsense", designerId, "DESIGNER")).response.status).toBe(400);
  });

  it("refuses a designer and a pilot with 403", async () => {
    const byDesigner = await list("", designerId, "DESIGNER");
    expect(byDesigner.response.status).toBe(403);
    expect(byDesigner.body.status).toBe("FORBIDDEN");
    // No trail is disclosed to a rejected caller.
    expect(byDesigner.body.content).toBeUndefined();

    expect((await list("", targetId, "PILOT")).response.status).toBe(403);
  });

  it("leaves no trail of its own — reading the log is not an audited action", async () => {
    const before = await getDb().select().from(auditLog).where(eq(auditLog.actorId, adminId));

    await list(`?q=${encodeURIComponent(runId)}`);

    const after = await getDb().select().from(auditLog).where(eq(auditLog.actorId, adminId));
    expect(after).toHaveLength(before.length);
  });
});

describe.skipIf(hasDb)("GET /api/v1/audit-log (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
