import { expect, test, type Page } from "@playwright/test";

/**
 * Playwright happy-path e2e for Phase 1 — Auth & current user.
 *
 * Live-DB only: drives the real running app (register/login pages, the real
 * `/api/v1/**` routes) against the local Postgres started by
 * `docker compose up db` (see `MIGRATION_PLAN.md` §8) — skipped, with a
 * visible reason, whenever `DATABASE_URL` isn't configured, mirroring the
 * `hasDb` convention in `src/lib/audit.test.ts` /
 * `src/app/api/v1/auth/routes.test.ts` and `GET /api/health`'s own
 * `not_configured` branch. `playwright.config.ts` forwards `DATABASE_URL`
 * from `.env.local`/`.env` (or a real CI secret) into `process.env` for this
 * file to read, the same way `vitest.config.ts` already does for the
 * Vitest live-DB suites.
 *
 * Greenfield e2e coverage, not a JUnit/Angular port — there's no single
 * source test to mirror. SOURCE (behavior reference): the Angular flows
 * ported by the earlier Phase 1 tasks (`login.component`,
 * `register.component`, `app.component`, `auth.guard`'s `authGuard` /
 * `landingGuard`) + `MIGRATION_PLAN.md` §9's "Lifecycle e2e" guidance.
 *
 * Coverage note — `src/app/(app)/missions/mine/page.tsx` and
 * `src/app/(app)/missions/page.tsx` are minimal placeholder pages (the
 * missions phase replaces their content), added specifically so the
 * `(app)` route group has a real segment tree to mount for a DESIGNER/PILOT
 * visitor. Without at least one page under `(app)`, its layout — the
 * anonymous-visitor guard and the `Topbar` it renders (profile chip, logout
 * button) — never runs at all, since a route group's layout only mounts for
 * a segment tree that resolves to an actual page. With the stubs in place
 * this spec drives the real UI end to end: an anonymous visit to a
 * protected route redirects to `/login`, the profile chip renders the
 * logged-in username, and logout is triggered by clicking the topbar's
 * actual "Log out" button rather than simulating its effects.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

test.describe("Phase 1 auth happy path (live DB)", () => {
  test.skip(!hasDb, "DATABASE_URL not configured — see MIGRATION_PLAN.md §8");

  // Steps build on each other (register -> login -> logout), so this suite
  // must run in declared order — `playwright.config.ts` sets
  // `fullyParallel: true`, which otherwise runs same-file tests concurrently.
  test.describe.configure({ mode: "serial" });

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const designer = {
    username: `designer-${runId}`,
    email: `e2e-auth-${runId}-designer@example.com`,
    password: "password123",
  };
  const pilot = {
    username: `pilot-${runId}`,
    email: `e2e-auth-${runId}-pilot@example.com`,
    password: "password123",
  };

  /** Reads the JWT `auth.client.ts` stores under `dm_token`. */
  function readToken(page: Page): Promise<string | null> {
    return page.evaluate(() => window.localStorage.getItem("dm_token"));
  }

  test("register a DESIGNER via the query-prefilled role radio, land on /login?registered=1", async ({
    page,
  }) => {
    await page.goto(`/register?role=DESIGNER`);
    await expect(page.getByRole("radio", { name: /^Designer/ })).toBeChecked();

    await page.getByLabel("Username").fill(designer.username);
    await page.getByLabel("Email").fill(designer.email);
    await page.getByLabel("Password").fill(designer.password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/login\?registered=1$/);
    await expect(page.getByRole("status")).toHaveText("Account created — sign in to continue.");
  });

  test("register a PILOT via the interactive role radiogroup, land on /login?registered=1", async ({
    page,
  }) => {
    await page.goto("/register");
    await page.getByLabel("Username").fill(pilot.username);
    await page.getByLabel("Email").fill(pilot.email);
    await page.getByLabel("Password").fill(pilot.password);
    await page.getByRole("radio", { name: /^Pilot/ }).check({ force: true });
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/login\?registered=1$/);
    await expect(page.getByRole("status")).toHaveText("Account created — sign in to continue.");
  });

  test("logging in as the DESIGNER lands on their role home and /users/me returns their profile", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(designer.email);
    await page.getByLabel("Password").fill(designer.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // LoginForm pushes "/"; the landing page's isLoggedIn()/roleHomePath()
    // effect then replaces it with the role home — DESIGNER -> /missions/mine.
    await expect(page).toHaveURL(/\/missions\/mine$/);

    // The (app) shell's Topbar profile chip loads the caller's own profile
    // (GET /api/v1/users/me) and renders it once the guard has resolved.
    await expect(page.getByText(designer.username, { exact: true })).toBeVisible();
    await expect(page.getByText("Mission Designer", { exact: true })).toBeVisible();

    const token = await readToken(page);
    expect(token).toBeTruthy();

    const meResponse = await page.request.get("/api/v1/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meResponse.status()).toBe(200);
    const profile = await meResponse.json();
    expect(profile).toMatchObject({
      username: designer.username,
      email: designer.email,
      role: "DESIGNER",
      suspended: false,
    });
    expect(profile).not.toHaveProperty("passwordHash");
  });

  test("logging in as the PILOT lands on their role home and /users/me returns their profile", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(pilot.email);
    await page.getByLabel("Password").fill(pilot.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // PILOT -> /missions (not /missions/mine — that's the DESIGNER home).
    await expect(page).toHaveURL(/\/missions$/);

    const token = await readToken(page);
    expect(token).toBeTruthy();

    const meResponse = await page.request.get("/api/v1/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meResponse.status()).toBe(200);
    const profile = await meResponse.json();
    expect(profile).toMatchObject({
      username: pilot.username,
      email: pilot.email,
      role: "PILOT",
      suspended: false,
    });
  });

  test("the protected API rejects an anonymous caller with 401", async ({ request }) => {
    const response = await request.get("/api/v1/users/me");
    expect(response.status()).toBe(401);
  });

  test("visiting a protected (app) route anonymously redirects to /login", async ({ page }) => {
    // Exercises (app)/layout.tsx's own guard (mirrors authGuard) via real
    // full-page navigation, now that /missions/mine is a real page.
    await page.goto("/missions/mine");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("logging out via the topbar button clears the session and returns to /login", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(designer.email);
    await page.getByLabel("Password").fill(designer.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/missions\/mine$/);

    const token = await readToken(page);
    expect(token).toBeTruthy();

    // Click the real topbar button (components/app-shell/topbar.tsx): it
    // calls the real POST /api/v1/auth/logout route, then discards the
    // token and navigates to /login regardless of that call's outcome.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await readToken(page)).toBeNull();

    // With the session cleared, the landing page's isLoggedIn() check — the
    // same one the (app) guard uses — is false, so an anonymous visitor
    // sees the public landing content instead of a role-home redirect.
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "The marketplace for drone flight missions" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });
});
