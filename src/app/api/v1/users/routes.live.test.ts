import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, mission, users } from "@/db/schema";
import type { UserRole } from "@/db/schema";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import { POST as registerRoute } from "../auth/register/route";
import { GET as feedRoute, POST as createMissionRoute } from "../missions/route";
import { GET as listRoute } from "./route";
import { GET as byIdRoute } from "./[id]/route";
import { POST as createAdminRoute } from "./admins/route";
import { POST as suspendRoute } from "./[id]/suspend/route";
import { POST as reactivateRoute } from "./[id]/reactivate/route";

/**
 * Route-level **integration** suite for the phase-7 admin user endpoints: the
 * real handlers over the real `UserService`/`AuthService`, the real caching
 * mission DAO and a real Postgres, with nothing mocked.
 *
 * This is the live-DB counterpart of `routes.test.ts`, which mocks the two
 * services exactly as `UserControllerTest` does and therefore proves only what
 * the web layer contributes. Everything this file is here for lives *below*
 * that mock boundary:
 *
 * - suspend/reactivate actually writing `users.suspended`, and the audit row
 *   each state *change* leaves behind — including the two idempotent cases,
 *   where the endpoint still answers 200 but the table and the trail must be
 *   untouched;
 * - `invalidateLists()` doing its job against a warm cache: a suspended
 *   designer's missions must leave the marketplace on the very next read, even
 *   though the write landed on `users`, a table the mission DAO never observes.
 *   That is the one rule in `UserService.suspend` no mocked test can show, and
 *   the reason the invalidation is there at all;
 * - the ADMIN-target rejection reaching the caller as a 409 with nothing
 *   written and nothing audited;
 * - `POST /users/admins` over real rows: a bcrypt hash that is not the
 *   plaintext, the role forced to ADMIN, the `ADMIN_CREATED` row actored by the
 *   *creator*, and the duplicate-email conflict landing before any insert;
 * - the two response shapes over a real row — the admin listing's full
 *   `UserResponse` (email included, hash never) beside `GET /users/{id}`'s
 *   `PublicUserResponse`, which withholds email *and* the suspension flag.
 *
 * It lives in a separate file rather than in `routes.test.ts` because that
 * file's `vi.mock` of the user and auth services is module-scoped: a live-DB
 * block inside it would still be talking to the mocks. Same split, same
 * reasons, as `missions/routes.live.test.ts` beside `missions/routes.test.ts`.
 *
 * The 401 cases are not repeated here — anonymous rejection happens in
 * `src/middleware.ts`, above every handler and below no database, and
 * `routes.test.ts` drives the real middleware for exactly that.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * There is no Spring counterpart to mirror: the backend has no
 * `@SpringBootTest` integration suite. These cases are written against the
 * *behaviour* the ported source files specify, and each names the rule it pins.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../web/controller/user/UserController.java
 * - drone-missions-backend/.../business/service/user/UserService.java
 * - drone-missions-backend/.../business/service/auth/AuthService.java (`createAdmin`)
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("admin user routes (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();
  let emailCounter = 0;

  function uniqueEmail(label: string): string {
    emailCounter += 1;
    return `admin-users-${runId}-${emailCounter}-${label}@example.com`;
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
  async function registerTestUser(role: "DESIGNER" | "PILOT", label: string): Promise<number> {
    const response = await registerRoute(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: `admin-users-${label}`,
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
   * design, and `POST /users/admins` needs an admin to already exist — the
   * same bootstrap the V12 seed migration performs in a deployment.
   */
  async function seedAdmin(label: string): Promise<number> {
    const now = new Date();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `admin-users-${label}`,
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

  /** Every audit row written about one account. */
  async function auditRowsFor(userId: number) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetType, "USER"), eq(auditLog.targetId, userId)));
  }

  /** The live `users` row, straight from the table. */
  async function userRow(id: number) {
    const [row] = await getDb().select().from(users).where(eq(users.id, id));
    return row;
  }

  let adminId: number;
  let otherAdminId: number;
  let designerId: number;
  let pilotId: number;
  /** Created through `POST /users/admins`; tracked so cleanup can remove it. */
  let mintedAdminId: number | undefined;

  beforeAll(async () => {
    adminId = await seedAdmin("root");
    otherAdminId = await seedAdmin("colleague");
    designerId = await registerTestUser("DESIGNER", "designer");
    pilotId = await registerTestUser("PILOT", "pilot");
  });

  afterAll(async () => {
    if (mintedAdminId !== undefined) {
      insertedUserIds.push(mintedAdminId);
    }
    if (insertedUserIds.length > 0) {
      // Missions first: `fk_mission_user` has no cascade.
      await getDb().delete(mission).where(inArray(mission.userId, insertedUserIds));
      // Audit rows deliberately outlive their actor (see `audit_log`'s doc
      // comment in db/schema.ts), so they have to go explicitly.
      await getDb().delete(auditLog).where(inArray(auditLog.actorId, insertedUserIds));
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  describe("GET /api/v1/users", () => {
    it("wraps real rows in the paged envelope and shows the admin view, hash excluded", async () => {
      const response = await listRoute(
        getRequest("http://localhost/api/v1/users?size=2000", adminId, "ADMIN"),
        listContext,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      // `new PagedModel<>(…)` field-for-field — the Angular `PagedModel<T>` is
      // typed against exactly this.
      expect(Object.keys(body).sort()).toEqual(["content", "page"]);
      expect(Object.keys(body.page).sort()).toEqual([
        "number",
        "size",
        "totalElements",
        "totalPages",
      ]);
      expect(body.page).toMatchObject({ size: 2000, number: 0 });
      expect(body.page.totalPages).toBe(Math.ceil(body.page.totalElements / 2000));

      const designer = body.content.find((user: { id: number }) => user.id === designerId);
      // The admin view carries the email on purpose ("Full UserResponse (with
      // email) on purpose — this is the admin view")...
      expect(designer).toMatchObject({
        id: designerId,
        username: "admin-users-designer",
        role: "DESIGNER",
        suspended: false,
      });
      expect(designer.email).toContain("@example.com");
      // ...and never the hash: the mapper whitelists fields.
      expect(designer.passwordHash).toBeUndefined();
      expect(Object.keys(designer).sort()).toEqual([
        "createdAt",
        "email",
        "id",
        "role",
        "suspended",
        "username",
      ]);
    });

    it("narrows to one role and counts only that role", async () => {
      const pilots = await listRoute(
        getRequest("http://localhost/api/v1/users?role=PILOT&size=2000", adminId, "ADMIN"),
        listContext,
      );
      const body = await pilots.json();

      expect(pilots.status).toBe(200);
      expect(body.content.every((user: { role: string }) => user.role === "PILOT")).toBe(true);
      expect(body.content.map((user: { id: number }) => user.id)).toContain(pilotId);
      expect(body.content.map((user: { id: number }) => user.id)).not.toContain(designerId);
      // The count query carries the same filter.
      expect(body.page.totalElements).toBe(body.content.length);

      // An empty `?role=` is the Angular "All roles" option, not a bad request.
      const everyone = await listRoute(
        getRequest("http://localhost/api/v1/users?role=&size=2000", adminId, "ADMIN"),
        listContext,
      );
      const all = await everyone.json();
      expect(everyone.status).toBe(200);
      expect(all.content.map((user: { id: number }) => user.id)).toContain(designerId);
    });

    it("refuses a designer and a pilot with 403", async () => {
      for (const [id, role] of [
        [designerId, "DESIGNER"],
        [pilotId, "PILOT"],
      ] as const) {
        const response = await listRoute(
          getRequest("http://localhost/api/v1/users", id, role),
          listContext,
        );
        expect(response.status).toBe(403);
        expect((await response.json()).status).toBe("FORBIDDEN");
      }
    });
  });

  describe("GET /api/v1/users/{id}", () => {
    it("gives any authenticated caller the public shape — no email, no suspension flag", async () => {
      const response = await byIdRoute(
        // A pilot reading a designer's profile: `isAuthenticated()`, not
        // `hasRole('ADMIN')`.
        getRequest(`http://localhost/api/v1/users/${designerId}`, pilotId, "PILOT"),
        idContext(designerId),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        id: designerId,
        username: "admin-users-designer",
        role: "DESIGNER",
      });
      expect(Object.keys(body).sort()).toEqual(["createdAt", "id", "role", "username"]);
      expect(body.email).toBeUndefined();
      expect(body.suspended).toBeUndefined();
      expect(body.passwordHash).toBeUndefined();
    });

    it("answers 404 for an id that does not exist", async () => {
      const response = await byIdRoute(
        getRequest("http://localhost/api/v1/users/999999999", pilotId, "PILOT"),
        idContext(999999999),
      );

      expect(response.status).toBe(404);
      expect((await response.json()).status).toBe("NOT_FOUND");
    });
  });

  describe("POST /api/v1/users/{id}/suspend and /reactivate", () => {
    it("writes the flag, audits the admin who did it, and is idempotent on the second press", async () => {
      const target = await registerTestUser("PILOT", "suspendable");

      const response = await suspendRoute(
        postRequest(`http://localhost/api/v1/users/${target}/suspend`, adminId, "ADMIN"),
        idContext(target),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ id: target, suspended: true, role: "PILOT" });
      expect((await userRow(target)).suspended).toBe(true);

      const suspended = (await auditRowsFor(target)).filter(
        (entry) => entry.action === "USER_SUSPENDED",
      );
      expect(suspended).toHaveLength(1);
      expect(suspended[0]).toMatchObject({
        // The acting admin, off the verified headers — never the target.
        actorId: adminId,
        actorRole: "ADMIN",
        targetType: "USER",
        targetId: target,
        details: '"admin-users-suspendable"',
      });

      // Pressing it again still answers 200 with the current state, so the
      // admin table can re-render either way — but writes nothing and audits
      // nothing: one row means one state *change*.
      const before = await userRow(target);
      const again = await suspendRoute(
        postRequest(`http://localhost/api/v1/users/${target}/suspend`, otherAdminId, "ADMIN"),
        idContext(target),
      );
      expect(again.status).toBe(200);
      expect((await again.json()).suspended).toBe(true);
      const after = await userRow(target);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(
        (await auditRowsFor(target)).filter((entry) => entry.action === "USER_SUSPENDED"),
      ).toHaveLength(1);
    });

    it("lifts the suspension, audits the reactivation, and is idempotent in the same way", async () => {
      const target = await registerTestUser("DESIGNER", "reactivatable");
      await suspendRoute(
        postRequest(`http://localhost/api/v1/users/${target}/suspend`, adminId, "ADMIN"),
        idContext(target),
      );

      const response = await reactivateRoute(
        postRequest(`http://localhost/api/v1/users/${target}/reactivate`, adminId, "ADMIN"),
        idContext(target),
      );

      expect(response.status).toBe(200);
      expect((await response.json()).suspended).toBe(false);
      expect((await userRow(target)).suspended).toBe(false);
      expect(
        (await auditRowsFor(target)).map((entry) => entry.action).sort(),
      ).toEqual(["USER_REACTIVATED", "USER_REGISTERED", "USER_SUSPENDED"]);

      const before = await userRow(target);
      const again = await reactivateRoute(
        postRequest(`http://localhost/api/v1/users/${target}/reactivate`, adminId, "ADMIN"),
        idContext(target),
      );
      expect(again.status).toBe(200);
      expect((await userRow(target)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(
        (await auditRowsFor(target)).filter((entry) => entry.action === "USER_REACTIVATED"),
      ).toHaveLength(1);
    });

    it("drops the suspended designer's missions out of the live marketplace, and puts them back", async () => {
      // The rule `invalidateLists()` exists for, and the only one that needs a
      // warm cache in front of a real database to be visible at all: the write
      // lands on `users`, which the mission DAO never observes, so nothing else
      // would evict the stale id lists.
      const owner = await registerTestUser("DESIGNER", "feed-owner");
      const created = await createMissionRoute(
        jsonRequest(
          "http://localhost/api/v1/missions",
          {
            name: `Suspension feed ${runId}`,
            description: `Feed fixture ${runId}`,
            status: "PUBLISHED",
            startTime: new Date(2030, 8, 1, 8).toISOString(),
            endTime: new Date(2030, 8, 1, 10).toISOString(),
            location: `Novi Sad ${runId}`,
            biddingDeadline: "2030-08-25",
            // `@Size(min = 2)` — the shortest flight path the validator allows.
            waypoints: [
              { lat: 45.2671, lng: 19.8335, altitude: 60, action: "PHOTO" },
              { lat: 45.2681, lng: 19.8345, altitude: 80, action: "PHOTO" },
            ],
          },
          owner,
          "DESIGNER",
        ),
        listContext,
      );
      expect(created.status).toBe(201);
      const missionId = (await created.json()).id as number;
      const keyword = encodeURIComponent(`suspension feed ${runId}`);
      const feedIds = async () => {
        const response = await feedRoute(
          getRequest(`http://localhost/api/v1/missions?keyword=${keyword}`, pilotId, "PILOT"),
          listContext,
        );
        return (await response.json()).map((entry: { id: number }) => entry.id);
      };

      // Warm the list cache with the mission present...
      expect(await feedIds()).toEqual([missionId]);

      await suspendRoute(
        postRequest(`http://localhost/api/v1/users/${owner}/suspend`, adminId, "ADMIN"),
        idContext(owner),
      );
      expect(await feedIds()).toEqual([]);

      await reactivateRoute(
        postRequest(`http://localhost/api/v1/users/${owner}/reactivate`, adminId, "ADMIN"),
        idContext(owner),
      );
      expect(await feedIds()).toEqual([missionId]);
    });

    it("refuses to suspend another admin with 409, writing and auditing nothing", async () => {
      const response = await suspendRoute(
        postRequest(`http://localhost/api/v1/users/${otherAdminId}/suspend`, adminId, "ADMIN"),
        idContext(otherAdminId),
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.status).toBe("CONFLICT");
      expect(body.message).toBe(`User ${otherAdminId} is an admin and cannot be suspended`);
      expect((await userRow(otherAdminId)).suspended).toBe(false);
      expect(await auditRowsFor(otherAdminId)).toEqual([]);

      // The asymmetry the source keeps: reactivating an admin is not rejected,
      // it is the idempotent no-op (the account was never suspended).
      const reactivated = await reactivateRoute(
        postRequest(`http://localhost/api/v1/users/${otherAdminId}/reactivate`, adminId, "ADMIN"),
        idContext(otherAdminId),
      );
      expect(reactivated.status).toBe(200);
      expect(await auditRowsFor(otherAdminId)).toEqual([]);
    });

    it("answers 404 for an unknown target and 403 for a non-admin caller", async () => {
      const missing = await suspendRoute(
        postRequest("http://localhost/api/v1/users/999999999/suspend", adminId, "ADMIN"),
        idContext(999999999),
      );
      expect(missing.status).toBe(404);

      const byPilot = await suspendRoute(
        postRequest(`http://localhost/api/v1/users/${designerId}/suspend`, pilotId, "PILOT"),
        idContext(designerId),
      );
      expect(byPilot.status).toBe(403);
      // A rejected caller changes nothing and leaves no trail.
      expect((await userRow(designerId)).suspended).toBe(false);
      expect(
        (await auditRowsFor(designerId)).filter((entry) => entry.action === "USER_SUSPENDED"),
      ).toEqual([]);
    });
  });

  describe("POST /api/v1/users/admins", () => {
    it("mints a real ADMIN with a hashed password and audits the creator as the actor", async () => {
      const email = uniqueEmail("minted");

      const response = await createAdminRoute(
        jsonRequest(
          "http://localhost/api/v1/users/admins",
          { username: `admin-users-minted-${runId}`, email, password: "pw-long-enough" },
          adminId,
          "ADMIN",
        ),
        listContext,
      );
      const body = await response.json();

      expect(response.status).toBe(201);
      mintedAdminId = body.id as number;
      expect(body).toMatchObject({ email, role: "ADMIN", suspended: false });
      expect(body.passwordHash).toBeUndefined();

      const row = await userRow(mintedAdminId);
      // The role is forced, never read off the request: `createAdmin` takes no
      // role argument at all.
      expect(row.role).toBe("ADMIN");
      expect(row.passwordHash).not.toBe("pw-long-enough");
      expect(row.passwordHash.startsWith("$2")).toBe(true);

      // The twist this factory exists for: the row is targeted at the *new*
      // admin but actored by the one who created them.
      const [entry] = await auditRowsFor(mintedAdminId);
      expect(entry).toMatchObject({
        actorId: adminId,
        actorRole: "ADMIN",
        action: "ADMIN_CREATED",
        targetType: "USER",
        targetId: mintedAdminId,
        details: `"admin-users-minted-${runId}"`,
      });
    });

    it("rejects a duplicate email with 409 before inserting anything", async () => {
      const taken = (await userRow(designerId)).email;
      const before = await getDb().select().from(users).where(eq(users.email, taken));

      const response = await createAdminRoute(
        jsonRequest(
          "http://localhost/api/v1/users/admins",
          { username: `admin-users-clash-${runId}`, email: taken, password: "pw-long-enough" },
          adminId,
          "ADMIN",
        ),
        listContext,
      );

      expect(response.status).toBe(409);
      expect((await response.json()).message).toBe(`Email ${taken} is already registered`);
      // No second row, and the existing account is untouched — the duplicate
      // check runs before the hash and the insert.
      const after = await getDb().select().from(users).where(eq(users.email, taken));
      expect(after).toHaveLength(before.length);
      expect(after[0].role).toBe("DESIGNER");
    });

    it("refuses a designer with 403 and creates no account", async () => {
      const email = uniqueEmail("forbidden");

      const response = await createAdminRoute(
        jsonRequest(
          "http://localhost/api/v1/users/admins",
          { username: `admin-users-forbidden-${runId}`, email, password: "pw-long-enough" },
          designerId,
          "DESIGNER",
        ),
        listContext,
      );

      expect(response.status).toBe(403);
      expect(await getDb().select().from(users).where(eq(users.email, email))).toEqual([]);
    });
  });
});

describe.skipIf(hasDb)("admin user routes (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
