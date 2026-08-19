import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import { middleware } from "@/middleware";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import { POST as registerRoute } from "../../auth/register/route";
import { POST as loginRoute } from "../../auth/login/route";
import { GET as meRoute } from "./route";

/**
 * Route-level integration suite for `GET /api/v1/users/me`.
 *
 * Live-DB only, mirroring `src/app/api/v1/auth/routes.test.ts`: exercises
 * the real route handler against the local Postgres started by
 * `docker compose up db` — skipped, with a visible reason, when
 * `DATABASE_URL` isn't configured.
 *
 * `/api/v1/users/me` is authenticated-only (not in `middleware.ts`'s
 * `PUBLIC_PATHS`), so the anonymous case is exercised by calling
 * `middleware()` directly — the layer that actually rejects it in the
 * deployed app, same precedent as `routes.test.ts`'s logout suite — while
 * the authenticated cases call `meRoute` with the `x-user-id`/`x-user-role`
 * headers `middleware.ts` would have attached from the verified token's
 * `sub`/`role` claims (see `middleware.test.ts` for coverage of that
 * attachment itself).
 *
 * SOURCE: drone-missions-backend/.../web/controller/user/UserController.java (`me`)
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("GET /api/v1/users/me (live DB)", () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let emailCounter = 0;
  /** A fresh, unique email per call, so reruns against the same database never collide. */
  function uniqueEmail(label: string): string {
    emailCounter += 1;
    return `users-me-${runId}-${emailCounter}-${label}@example.com`;
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

  function meRequest(userId: number, role: "PILOT" | "DESIGNER" | "ADMIN" = "PILOT"): NextRequest {
    return new NextRequest(new URL("http://localhost/api/v1/users/me"), {
      headers: { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role },
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

  it("valid token returns the caller's own profile (no password hash leaked)", async () => {
    const email = uniqueEmail("own-profile");
    const registerResponse = await registerRoute(
      jsonRequest("http://localhost/api/v1/auth/register", {
        username: "mira",
        email,
        password: "password123",
        role: "PILOT",
      }),
      ctx,
    );
    const registered = await registerResponse.json();
    insertedUserIds.push(registered.id);

    const loginResponse = await loginRoute(
      jsonRequest("http://localhost/api/v1/auth/login", { email, password: "password123" }),
      ctx,
    );
    expect(loginResponse.status).toBe(200);

    const response = await meRoute(meRequest(registered.id, "PILOT"), ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: registered.id, username: "mira", email, role: "PILOT" });
    expect(body).not.toHaveProperty("passwordHash");
  });

  it("an anonymous request is rejected with 401 at the middleware layer", async () => {
    const request = new NextRequest(new URL("http://localhost/api/v1/users/me"));
    const response = await middleware(request);
    expect(response.status).toBe(401);
  });

  it("a token for an id that no longer exists returns 404", async () => {
    const { id } = await registerTestUser();

    // Delete the row (and its audit trail) so the id the token still names
    // no longer resolves — mirrors "token for a deleted id" without needing
    // an account-deletion endpoint, which doesn't exist in this phase.
    await getDb().delete(auditLog).where(eq(auditLog.actorId, id));
    await getDb().delete(users).where(eq(users.id, id));

    const response = await meRoute(meRequest(id, "PILOT"), ctx);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.status).toBe("NOT_FOUND");
  });
});

describe.skipIf(hasDb)("GET /api/v1/users/me (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
