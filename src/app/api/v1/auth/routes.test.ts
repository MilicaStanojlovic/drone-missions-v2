import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import { middleware } from "@/middleware";
import { POST as registerRoute } from "@/app/api/v1/auth/register/route";
import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { POST as logoutRoute } from "@/app/api/v1/auth/logout/route";

/**
 * Route-level integration suite for `POST /api/v1/auth/{register,login,logout}`.
 *
 * Live-DB only: exercises the real route handlers against the local Postgres
 * started by `docker compose up db` (see `MIGRATION_PLAN.md` §8), the same
 * way `src/lib/audit.test.ts` does — skipped, with a visible reason, when
 * `DATABASE_URL` isn't configured. `vitest.config.ts` forwards it from
 * `.env.local`/`.env` when present.
 *
 * Unlike `auth.service.test.ts` (mocked, unit-level, mirrors `AuthServiceTest`
 * case-for-case), this suite calls the exported route handlers directly —
 * `registerRoute`/`loginRoute` bypass `src/middleware.ts` entirely, exactly
 * like real traffic does (both paths are in its `PUBLIC_PATHS`), while the
 * logout cases go through `middleware()` itself, since that's the layer that
 * actually rejects an anonymous logout request in the deployed app — the
 * route handler itself performs no auth check of its own (see its doc
 * comment).
 *
 * SOURCE: drone-missions-backend/.../web/controller/auth/AuthController.java
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("auth routes (live DB)", () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let emailCounter = 0;
  /** A fresh, unique email per call, so reruns against the same database never collide. */
  function uniqueEmail(label: string): string {
    emailCounter += 1;
    return `auth-route-${runId}-${emailCounter}-${label}@example.com`;
  }

  const insertedUserIds: number[] = [];
  const ctx = { params: Promise.resolve({}) };

  function jsonRequest(url: string, body: unknown): Request {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function registerTestUser(role: "PILOT" | "DESIGNER" = "PILOT") {
    const email = uniqueEmail("helper");
    const response = await registerRoute(
      jsonRequest("http://localhost/api/v1/auth/register", {
        username: "route-test-user",
        email,
        password: "password123",
        role,
      }),
      ctx,
    );
    const body = await response.json();
    insertedUserIds.push(body.id);
    return { email, id: body.id as number };
  }

  afterAll(async () => {
    for (const id of insertedUserIds) {
      // Audit rows have no cascading FK to the user (see db/schema.ts's
      // audit_log doc comment — history must outlive a deletable actor), so
      // they're cleaned up explicitly, before the user row they reference.
      await getDb().delete(auditLog).where(eq(auditLog.actorId, id));
      await getDb().delete(users).where(eq(users.id, id));
    }
    await closeDb();
  });

  describe("POST /api/v1/auth/register", () => {
    it("returns 201 with a UserResponse body that never leaks the password hash", async () => {
      const email = uniqueEmail("register-ok");
      const response = await registerRoute(
        jsonRequest("http://localhost/api/v1/auth/register", {
          username: "mira",
          email,
          password: "password123",
          role: "PILOT",
        }),
        ctx,
      );
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body).toMatchObject({
        username: "mira",
        email,
        role: "PILOT",
        suspended: false,
      });
      expect(body.id).toEqual(expect.any(Number));
      expect(Object.keys(body).sort()).toEqual(
        ["createdAt", "email", "id", "role", "suspended", "username"].sort(),
      );
      insertedUserIds.push(body.id);
    });

    it("returns 409 when the email is already registered", async () => {
      const { email } = await registerTestUser("DESIGNER");

      const response = await registerRoute(
        jsonRequest("http://localhost/api/v1/auth/register", {
          username: "second",
          email,
          password: "password123",
          role: "DESIGNER",
        }),
        ctx,
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.status).toBe("CONFLICT");
    });

    it("blocks self-registering as ADMIN with the source's forbidden status (403) and inserts no row", async () => {
      const email = uniqueEmail("register-admin");
      const response = await registerRoute(
        jsonRequest("http://localhost/api/v1/auth/register", {
          username: "eve",
          email,
          password: "password123",
          role: "ADMIN",
        }),
        ctx,
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.status).toBe("FORBIDDEN");

      const rows = await getDb().select().from(users).where(eq(users.email, email));
      expect(rows).toHaveLength(0);
    });

    it("returns 400 with field errors for an invalid payload", async () => {
      const response = await registerRoute(
        jsonRequest("http://localhost/api/v1/auth/register", {
          username: "",
          email: "not-an-email",
          password: "short",
          role: "PILOT",
        }),
        ctx,
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.status).toBe("BAD_REQUEST");
      expect(body.data).toMatchObject({
        username: expect.any(String),
        email: expect.any(String),
        password: "password must be at least 8 characters",
      });
    });
  });

  describe("POST /api/v1/auth/login", () => {
    it("returns 200 with the token in the Authorization response header and the UserResponse body", async () => {
      const { email, id } = await registerTestUser();

      const response = await loginRoute(
        jsonRequest("http://localhost/api/v1/auth/login", { email, password: "password123" }),
        ctx,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get("authorization")).toMatch(/^Bearer .+/);
      expect(body).toMatchObject({ id, email });
      expect(body).not.toHaveProperty("passwordHash");
    });

    it("returns 401 for a wrong password", async () => {
      const { email } = await registerTestUser();

      const response = await loginRoute(
        jsonRequest("http://localhost/api/v1/auth/login", { email, password: "totally-wrong" }),
        ctx,
      );
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.status).toBe("UNAUTHORIZED");
      expect(response.headers.get("authorization")).toBeNull();
    });

    it("returns the identical 401 for an unknown email", async () => {
      const response = await loginRoute(
        jsonRequest("http://localhost/api/v1/auth/login", {
          email: uniqueEmail("nobody"),
          password: "whatever1",
        }),
        ctx,
      );
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.status).toBe("UNAUTHORIZED");
    });

    it("returns 400 with field errors for an empty payload", async () => {
      const response = await loginRoute(
        jsonRequest("http://localhost/api/v1/auth/login", { email: "", password: "" }),
        ctx,
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.status).toBe("BAD_REQUEST");
      expect(body.data).toMatchObject({
        email: expect.any(String),
        password: expect.any(String),
      });
    });

    it("logs in with a whitespace-padded password identical to the one registered with (regression: loginSchema must not trim)", async () => {
      // Guards the account-lockout defect from fix pass 2, finding 1:
      // registering with a leading/trailing-whitespace password and then
      // logging in with the exact same padded string must succeed, because
      // AuthService.createUser/login both hash/compare the raw untrimmed
      // value. A `.trim()` transform on loginSchema.password would make the
      // service receive a different string than what was hashed at
      // registration, so this would previously fail with 401.
      const email = uniqueEmail("padded-password");
      const paddedPassword = "  secret12  ";
      const registerResponse = await registerRoute(
        jsonRequest("http://localhost/api/v1/auth/register", {
          username: "padded-pw-user",
          email,
          password: paddedPassword,
          role: "PILOT",
        }),
        ctx,
      );
      const registerBody = await registerResponse.json();
      expect(registerResponse.status).toBe(201);
      insertedUserIds.push(registerBody.id);

      const loginResponse = await loginRoute(
        jsonRequest("http://localhost/api/v1/auth/login", { email, password: paddedPassword }),
        ctx,
      );
      const loginBody = await loginResponse.json();

      expect(loginResponse.status).toBe(200);
      expect(loginResponse.headers.get("authorization")).toMatch(/^Bearer .+/);
      expect(loginBody.id).toBe(registerBody.id);
    });
  });

  describe("POST /api/v1/auth/logout", () => {
    it("an anonymous request is rejected with 401 at the middleware layer (logout is not in PUBLIC_PATHS)", async () => {
      const request = new NextRequest(new URL("http://localhost/api/v1/auth/logout"), {
        method: "POST",
      });
      const response = await middleware(request);
      expect(response.status).toBe(401);
    });

    it("an authenticated request passes the middleware and the route returns 204", async () => {
      const { email } = await registerTestUser();
      const loginResponse = await loginRoute(
        jsonRequest("http://localhost/api/v1/auth/login", { email, password: "password123" }),
        ctx,
      );
      const token = loginResponse.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      expect(token).toBeTruthy();

      const request = new NextRequest(new URL("http://localhost/api/v1/auth/logout"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const middlewareResponse = await middleware(request);
      expect(middlewareResponse.status).not.toBe(401);

      const response = await logoutRoute(request, ctx);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    });
  });
});

describe.skipIf(hasDb)("auth routes (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
