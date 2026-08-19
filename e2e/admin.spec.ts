import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";

/**
 * Playwright happy-path e2e for Phase 7 — Admin & Moderation + Audit read.
 *
 * Drives the real running app against the local Postgres started by
 * `docker compose up db` (see `MIGRATION_PLAN.md` §8) through the whole
 * moderation story this phase ships: an admin signs in, works the users table
 * (suspend a pilot, reactivate them, mint another admin), works the all-missions
 * table (hide a mission, watch it leave the pilot feed, unhide it, remove it for
 * good), then reads the audit trail those six actions wrote and narrows it with
 * every filter the page offers. The last test is the negative half: a pilot and
 * a designer are bounced out of `/admin/*`, and pilot/anonymous callers are
 * refused by the admin endpoints themselves.
 *
 * Live-DB only, skipped with a visible reason when `DATABASE_URL` isn't
 * configured — the same `hasDb` convention as `e2e/lifecycle.spec.ts`,
 * `e2e/bids.spec.ts` and the live-DB Vitest suites. `playwright.config.ts`
 * forwards `DATABASE_URL` from `.env.local`/`.env` (or a real CI secret) into
 * `process.env` for this file to read.
 *
 * Greenfield e2e coverage, not a JUnit/Angular port — there is no single source
 * test to mirror. SOURCE (behaviour reference): the flows ported by this
 * phase's earlier tasks —
 * - `UserService.search`/`suspend`/`reactivate` and `AuthService.createAdmin`
 *   (the admin user management endpoints, and the audit rows they write);
 * - `MissionService.searchAll`/`hide`/`unhide`/`remove` (the moderation state
 *   machine, the cache eviction that takes a hidden mission out of the open
 *   feed, and the hard delete `remove` performs);
 * - `AuditService.search` + `AuditLogController.list` (the `actorId`/`action`/
 *   `role`/`q` filters and the paged envelope);
 * - `admin-users`, `admin-register`, `admin-missions`, `admin-audit-log`
 *   components and the `adminGuard` that fronts all four routes.
 *
 * **Why the admin account is minted here rather than taken from V12.** The plan
 * offers either the migration-seeded `admin@drone-missions.local` or an admin
 * created in test setup. This suite does the latter: V12 seeds only a BCrypt
 * *hash* (a dev credential, deliberately with no plaintext recorded anywhere in
 * either repo), so no spec can sign in as that account without inventing a
 * password for it. Registration refuses to mint an ADMIN — by design, per
 * `AuthService.register` — so the account is registered through the real public
 * endpoint and then promoted with one `update users set role = 'ADMIN'`, which
 * is exactly how V12 itself creates the first admin and is the same raw-SQL
 * seeding `e2e/notifications.spec.ts` already relies on. The V12 row is still
 * asserted to exist below, because everything here depends on that migration
 * having widened `users_role_check` to accept ADMIN at all.
 *
 * Steps build on each other (suspend → reactivate → hide → unhide → remove →
 * read the trail), so the suite runs serially and shares its ids between tests;
 * each test signs its user in through the real login form, exactly as
 * `e2e/lifecycle.spec.ts` does, because every test gets a fresh browser context
 * (and so an empty `localStorage`).
 *
 * The three accounts and the one mission they moderate are fixtures, so they
 * are created through the real public API in `beforeAll` rather than through
 * the register form and the planner: building a flight plan by clicking the
 * Leaflet canvas is Phase 2 behaviour, already covered end-to-end by its own
 * spec, and repeating it here would spend the run's slowest steps on something
 * this phase does not change. Everything this phase *does* ship is driven
 * through the browser.
 */
const DATABASE_URL = process.env.DATABASE_URL;

/** A user this suite registers and drives. */
interface Account {
  username: string;
  email: string;
  password: string;
  role: "DESIGNER" | "PILOT";
}

test.describe("Phase 7 admin & moderation happy path (live DB)", () => {
  test.skip(!DATABASE_URL, "DATABASE_URL not configured — see MIGRATION_PLAN.md §8");

  // `playwright.config.ts` sets `fullyParallel: true`, which would otherwise
  // run these same-file tests concurrently.
  test.describe.configure({ mode: "serial" });

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = "password123";

  /**
   * The account promoted to ADMIN before it ever signs in — see the file
   * header. Registered as a PILOT because registration accepts only the two
   * marketplace roles; the promotion below is what the JWT then carries.
   */
  const admin: Account = {
    username: `adm-admin-${runId}`,
    email: `e2e-adm-${runId}-admin@example.com`,
    password,
    role: "PILOT",
  };
  /** Owns the mission that gets hidden, unhidden and finally removed. */
  const designer: Account = {
    username: `adm-designer-${runId}`,
    email: `e2e-adm-${runId}-designer@example.com`,
    password,
    role: "DESIGNER",
  };
  /** The moderation target: suspended, then reactivated. */
  const pilot: Account = {
    username: `adm-pilot-${runId}`,
    email: `e2e-adm-${runId}-pilot@example.com`,
    password,
    role: "PILOT",
  };
  /** Minted through `/admin/users/new` by the first admin, mid-suite. */
  const secondAdmin = {
    username: `adm-second-${runId}`,
    email: `e2e-adm-${runId}-second@example.com`,
    password,
  };

  /**
   * Unique per run: this suite shares its database with every other run, and
   * the admin tables, the pilot feed and the audit log are all lists, so only
   * a name/location nothing else can carry makes the assertions below exact.
   * The mission name also carries `runId`, which is what lets the admin
   * search (`?q`, matched against mission name *or* designer) narrow the
   * all-missions table down to this one row.
   */
  const missionName = `Admin moderation survey ${runId}`;
  const missionLocation = `Moderaton-${runId}`;

  /**
   * Direct connection for the ADMIN promotion and the cleanup below —
   * deliberately not `src/db/client.ts`, which is `import "server-only"` and
   * belongs to the app process, not to this test runner. Same reasoning as
   * `e2e/notifications.spec.ts`.
   */
  let sql: postgres.Sql;
  /** Shared request context for the fixtures; disposed in `afterAll`. */
  let api: APIRequestContext;

  let missionId = 0;
  let pilotId = 0;
  let adminId = 0;
  let designerId = 0;
  /** The pilot's bearer, replayed to read the open feed as a pilot sees it. */
  let pilotAuth = "";

  // ---- fixtures (the real public API — see the file header) ----

  function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  /** `yyyy-MM-dd`, the wire form of the `LocalDate` `biddingDeadline`. */
  function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  async function registerViaApi(account: Account): Promise<void> {
    const response = await api.post("/api/v1/auth/register", {
      data: {
        username: account.username,
        email: account.email,
        password: account.password,
        role: account.role,
      },
    });
    expect(response.status()).toBe(201);
  }

  /** Signs in over the API and returns the `Authorization` header to replay. */
  async function bearerFor(account: { email: string; password: string }): Promise<string> {
    const login = await api.post("/api/v1/auth/login", {
      data: { email: account.email, password: account.password },
    });
    expect(login.status()).toBe(200);
    // The JWT arrives in the response header (see the login route), not the body.
    const authorization = login.headers()["authorization"];
    expect(authorization).toBeTruthy();
    return authorization;
  }

  /** Looks a registered account's id up by email (bigint arrives as a string). */
  async function userIdOf(email: string): Promise<number> {
    const rows = await sql<{ id: string }[]>`select id from users where email = ${email}`;
    return Number(rows[0].id);
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    if (!DATABASE_URL) {
      return;
    }
    sql = postgres(DATABASE_URL, { max: 2 });
    api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });

    // V12 is what makes an ADMIN account expressible at all (it widens
    // `users_role_check` and seeds the first one). Asserting its row is here
    // guards the promotion below against silently running on a database whose
    // migrations stopped short.
    const seeded = await sql<{ role: string }[]>`
      select role from users where email = 'admin@drone-missions.local'
    `;
    expect(seeded[0]?.role).toBe("ADMIN");

    await registerViaApi(admin);
    await registerViaApi(designer);
    await registerViaApi(pilot);

    adminId = await userIdOf(admin.email);
    designerId = await userIdOf(designer.email);
    pilotId = await userIdOf(pilot.email);

    // The promotion (see the file header). It must happen before the first
    // sign-in: the role travels in the JWT, so a token minted while this
    // account was still a PILOT would keep behaving like one.
    await sql`update users set role = 'ADMIN', updated_at = now() where id = ${adminId}`;

    pilotAuth = await bearerFor(pilot);

    // A PUBLISHED mission owned by the designer — PUBLISHED, not DRAFT, because
    // only an open mission appears in the pilot feed, which is what the hide
    // and unhide steps are checked against. The two waypoints are the minimum a
    // flight path may have (`@Size(min = 2)`).
    const created = await api.post("/api/v1/missions", {
      headers: { Authorization: await bearerFor(designer) },
      data: {
        name: missionName,
        description: "Two passes at 60 m, 4K plus thermal.",
        status: "PUBLISHED",
        startTime: daysFromNow(3).toISOString(),
        endTime: daysFromNow(9).toISOString(),
        location: missionLocation,
        biddingDeadline: isoDay(daysFromNow(2)),
        waypoints: [
          { lat: 44.8, lng: 20.45, altitude: 60, action: "PHOTO" },
          { lat: 44.81, lng: 20.46, altitude: 60, action: "PHOTO" },
        ],
        geofence: null,
      },
    });
    expect(created.status()).toBe(201);
    missionId = ((await created.json()) as { id: number }).id;
    expect(missionId).toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    await api?.dispose();
    if (!sql) {
      return;
    }
    // Ordered by FK, as `e2e/notifications.spec.ts` documents: `audit_log` has
    // no cascade on its actor (history must never be erasable through a user
    // row), so every row this run wrote has to go before the accounts do. The
    // mission goes first because its bids/notifications/ratings hang off it.
    const emails = [admin.email, designer.email, pilot.email, secondAdmin.email];
    const actorIds = [adminId, designerId, pilotId].filter(Boolean);
    if (designerId) {
      await sql`delete from mission where user_id = ${designerId}`;
    }
    // The second admin's id is unknown unless the create test ran, so its audit
    // rows are cleared by looking the account up rather than by a cached id.
    await sql`
      delete from audit_log
       where actor_id in (select id from users where email in ${sql(emails)})
    `;
    if (actorIds.length > 0) {
      await sql`delete from audit_log where actor_id in ${sql(actorIds)}`;
    }
    await sql`delete from users where email in ${sql(emails)}`;
    await sql.end();
  });

  // ---- account helpers (the real login form — see e2e/lifecycle.spec.ts) ----

  /** Signs in and waits for the role home `landingGuard` redirects to. */
  async function signIn(page: Page, account: { email: string; password: string }, home: RegExp) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(home);
  }

  /**
   * Signs the admin in. ADMIN's `roleHomePath` is `/admin/overview`, whose one
   * fetch (`GET /api/v1/platform-stats`) exists as of Phase 9, so the page now
   * renders real aggregates. Nothing this suite asserts depends on them: the
   * landing is only the proof that an ADMIN token gets past `RequireAdmin`.
   * The dashboard itself is covered by `e2e/stats.spec.ts`.
   */
  function signInAsAdmin(page: Page): Promise<void> {
    return signIn(page, admin, /\/admin\/overview$/);
  }

  // ---- page helpers ----

  /** The transient status message `useToast` raises (`role="status"`). */
  function toast(page: Page): Locator {
    return page.getByRole("status");
  }

  /** The confirm dialog `ConfirmDialog` renders while `open`. */
  function dialog(page: Page): Locator {
    return page.getByRole("alertdialog");
  }

  /**
   * One row of the users table, found by the username cell's `title`. The
   * matching set is exactly {section, table container, row} — the three
   * ancestors that carry both the titled cell and a button — so `.last()` is
   * the row itself, ancestors sorting before descendants in DOM order (the
   * same idiom `e2e/lifecycle.spec.ts` uses for a bid row).
   */
  function userRow(page: Page, username: string): Locator {
    return page
      .locator("div")
      .filter({ has: page.getByTitle(username, { exact: true }) })
      .filter({ has: page.getByRole("button") })
      .last();
  }

  /**
   * One row of the audit feed, found by the `details` line the moderation
   * factories write (the target's name in literal double quotes) plus the
   * day-granularity age beside it. Two hops up from that line is the row: the
   * details `div` sits in the entry's content column, which sits in the row.
   */
  function auditEntry(page: Page, target: string): Locator {
    return page.getByText(`"${target}" · today`).locator("xpath=../..");
  }

  /** The pager caption of a table, which doubles as its exact result count. */
  function pager(page: Page, noun: "users" | "missions" | "entries"): Locator {
    return page.getByText(new RegExp(`^Page \\d+ of \\d+ · \\d+ ${noun}$`));
  }

  /** The total from a pager caption ("Page 1 of 3 · 47 users" → 47). */
  async function total(page: Page, noun: "users" | "missions" | "entries"): Promise<number> {
    const caption = await pager(page, noun).textContent();
    return Number(/· (\d+) /.exec(caption ?? "")?.[1]);
  }

  /**
   * Whether the mission is in the open marketplace feed, read as a pilot sees
   * it. The server's own answer rather than the rendered list: hide/unhide are
   * about what the feed query (and the list cache behind it) returns, and the
   * `?location` filter narrows it to this run's mission alone.
   */
  async function feedHasMission(): Promise<boolean> {
    const response = await api.get(
      `/api/v1/missions?location=${encodeURIComponent(missionLocation)}`,
      { headers: { Authorization: pilotAuth } },
    );
    expect(response.status()).toBe(200);
    const missions = (await response.json()) as { id: number }[];
    return missions.some((mission) => mission.id === missionId);
  }

  /**
   * Applies one audit-log filter combination and waits for the debounced
   * (300 ms) reload to land. `q` is typed rather than deep-linked so the real
   * control — and the debounce + `distinctUntilChanged` behind it — is what
   * produces the request.
   */
  async function filterAuditLog(
    page: Page,
    filters: { q?: string; action?: string; role?: string },
  ): Promise<void> {
    if (filters.q !== undefined) {
      await page.getByLabel("Search by user or detail").fill(filters.q);
    }
    if (filters.action !== undefined) {
      await page.getByLabel("Filter by action").selectOption(filters.action);
    }
    if (filters.role !== undefined) {
      await page.getByRole("button", { name: filters.role, exact: true }).click();
    }
  }

  // ---- the tests ----

  test("the admin reaches the users table from the topbar and sees both accounts", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    // The four-link admin section nav the topbar only renders for an ADMIN.
    await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Audit Log" })).toBeVisible();
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();

    // The role segments narrow server-side (`?role=`), which is also what keeps
    // this run's rows on the newest-first first page of a shared database.
    await page.getByRole("button", { name: "Pilots" }).click();
    await expect(page).toHaveURL(/\/admin\/users\?role=PILOT$/);
    await expect(userRow(page, pilot.username)).toContainText(pilot.email);
    await expect(userRow(page, pilot.username)).toContainText("Pilot");
    await expect(userRow(page, pilot.username)).toContainText("Active");
    // Every listed account is a pilot now, so the designer is not among them.
    await expect(page.getByTitle(designer.username, { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Designers" }).click();
    await expect(page).toHaveURL(/\/admin\/users\?role=DESIGNER$/);
    await expect(userRow(page, designer.username)).toContainText(designer.email);
    await expect(userRow(page, designer.username)).toContainText("Designer");

    // The admin view is the one that carries the email at all — that is what
    // separates `UserResponse` here from the `PublicUserResponse` every other
    // caller gets.
    await expect(pager(page, "users")).toBeVisible();
  });

  test("suspending a pilot sticks, and reactivating lifts it", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/users?role=PILOT");

    const row = userRow(page, pilot.username);
    await expect(row).toContainText("Active");
    await row.getByRole("button", { name: "Suspend" }).click();

    // Suspension is consequential, so the source puts a confirmation in front
    // of it — with the *pilot* wording, since the target's role picks the copy.
    await expect(dialog(page)).toContainText(`Suspend ${pilot.username}?`);
    await expect(dialog(page)).toContainText("unable to place bids");
    await dialog(page).getByRole("button", { name: "Suspend pilot" }).click();

    await expect(toast(page)).toHaveText(`${pilot.username} suspended`);
    // `replaceRow` swapped in the `UserResponse` the endpoint returned, so the
    // chip and the action flip without a reload…
    await expect(row).toContainText("Suspended");
    await expect(row.getByRole("button", { name: "Reactivate" })).toBeVisible();

    // …and a reload proves it was written, not merely applied optimistically.
    await page.reload();
    await expect(userRow(page, pilot.username)).toContainText("Suspended");

    // Lifting a suspension is reversible, so the source asks nothing first.
    await userRow(page, pilot.username).getByRole("button", { name: "Reactivate" }).click();
    await expect(toast(page)).toHaveText(`${pilot.username} reactivated`);
    await expect(userRow(page, pilot.username)).toContainText("Active");

    await page.reload();
    await expect(userRow(page, pilot.username)).toContainText("Active");
    await expect(
      userRow(page, pilot.username).getByRole("button", { name: "Suspend" }),
    ).toBeVisible();
  });

  test("an admin mints another admin, who then has no suspend action", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/users");

    await page.getByRole("link", { name: "New Admin" }).click();
    await expect(page).toHaveURL(/\/admin\/users\/new$/);

    await page.getByLabel("Username").fill(secondAdmin.username);
    await page.getByLabel("Email").fill(secondAdmin.email);
    await page.getByLabel("Initial password").fill(secondAdmin.password);
    await page.getByRole("button", { name: "Create admin" }).click();

    // The form hands the new username to the list page in the query string,
    // which raises the toast there and then drops the parameter again. The
    // toast is asserted first because it clears itself after 2.8 s.
    await expect(toast(page)).toHaveText(`Admin created — ${secondAdmin.username}`);
    await expect(page).toHaveURL(/\/admin\/users$/);

    await page.getByRole("button", { name: "Admins" }).click();
    await expect(page).toHaveURL(/\/admin\/users\?role=ADMIN$/);
    const created = page.getByTitle(secondAdmin.username, { exact: true });
    await expect(created).toBeVisible();
    // An ADMIN row offers no moderation at all — `AdminCannotBeSuspendedError`
    // is the server's half of the same rule, and the table simply renders a dash.
    await expect(created.locator("xpath=../..")).not.toContainText("Suspend");
  });

  test("hiding a mission takes it out of the pilot feed", async ({ page }) => {
    expect(await feedHasMission()).toBe(true);

    await signInAsAdmin(page);
    await page.getByRole("link", { name: "Missions", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/missions$/);

    // `?q` matches mission name or designer server-side; both carry `runId`,
    // so this narrows the shared table to exactly this run's one mission.
    await page.getByLabel("Search by mission or designer").fill(runId);
    await expect(page).toHaveURL(new RegExp(`/admin/missions\\?q=${runId}$`));
    await expect(pager(page, "missions")).toHaveText("Page 1 of 1 · 1 missions");
    await expect(page.getByTitle(missionName, { exact: true })).toBeVisible();
    await expect(page.getByText(designer.username, { exact: true })).toBeVisible();
    await expect(page.getByText("Published", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(dialog(page)).toContainText("Hide this mission?");
    await expect(dialog(page)).toContainText(missionName);
    await dialog(page).getByRole("button", { name: "Hide mission" }).click();

    await expect(toast(page)).toHaveText(`Hidden — ${missionName.slice(0, 34)}`);
    // The row was replaced by the returned `MissionResponse`, so the action
    // flipped to its inverse in place.
    await expect(page.getByRole("button", { name: "Unhide" })).toBeVisible();

    // The point of hiding: the mission is out of the open marketplace, which
    // also proves the mission list cache was evicted rather than left serving
    // the pre-hide page.
    expect(await feedHasMission()).toBe(false);
  });

  test("the pilot's feed no longer offers the hidden mission", async ({ page }) => {
    await signIn(page, pilot, /\/missions$/);

    await page.getByLabel("Filter by location").fill(missionLocation);
    // The empty state, not merely a missing card: it is what proves the
    // filtered request came back at all.
    await expect(page.getByText("No missions match your filters")).toBeVisible();
    await expect(
      page.locator('a[href^="/missions/"]').filter({ hasText: missionName }),
    ).toHaveCount(0);
  });

  test("unhiding restores the mission, and removing it deletes it for good", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto(`/admin/missions?q=${runId}`);
    await expect(pager(page, "missions")).toHaveText("Page 1 of 1 · 1 missions");

    // Unhide fires straight away — lifting a hide is reversible, so the source
    // puts no confirmation in front of it.
    await page.getByRole("button", { name: "Unhide" }).click();
    await expect(toast(page)).toHaveText(`Back in the feed — ${missionName.slice(0, 34)}`);
    await expect(page.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
    expect(await feedHasMission()).toBe(true);

    // Removal is a real delete (V15 cascades the bids, notifications and
    // ratings away with it), so it always confirms first.
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(dialog(page)).toContainText("Delete this mission?");
    await expect(dialog(page)).toContainText("permanently deleted");
    await dialog(page).getByRole("button", { name: "Delete mission" }).click();

    await expect(toast(page)).toHaveText(`Deleted — ${missionName.slice(0, 34)}`);
    // 204 comes back with no body, so the row is dropped rather than replaced
    // and the total steps down with it.
    await expect(page.getByTitle(missionName, { exact: true })).toHaveCount(0);
    await expect(page.getByText("No missions match your search.")).toBeVisible();

    // Gone from the feed, and gone from the API altogether.
    expect(await feedHasMission()).toBe(false);
    const gone = await api.get(`/api/v1/missions/${missionId}`, {
      headers: { Authorization: pilotAuth },
    });
    expect(gone.status()).toBe(404);
  });

  test("the audit log carries every action this run performed, and the filters narrow it", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.getByRole("link", { name: "Audit Log" }).click();
    await expect(page).toHaveURL(/\/admin\/audit-log$/);

    const unfiltered = await total(page, "entries");
    expect(unfiltered).toBeGreaterThan(0);

    // `q` matches the actor's username *or* the row's details, and every name
    // this run minted carries `runId` — so one search collects the whole story.
    await filterAuditLog(page, { q: runId });
    await expect(page).toHaveURL(new RegExp(`/admin/audit-log\\?q=${runId}$`));
    const mine = await total(page, "entries");
    expect(mine).toBeGreaterThan(0);
    expect(mine).toBeLessThanOrEqual(unfiltered);

    /**
     * Each moderation action wrote exactly one row, with the acting admin as
     * actor and the target's name quoted into `details` — so narrowing to one
     * action at a time is both the filter test and the proof that the row
     * exists, is attributed correctly, and was written only once.
     */
    const written: { action: string; sentence: string; target: string }[] = [
      { action: "USER_SUSPENDED", sentence: "suspended a user", target: pilot.username },
      { action: "USER_REACTIVATED", sentence: "reactivated a user", target: pilot.username },
      { action: "ADMIN_CREATED", sentence: "created an admin", target: secondAdmin.username },
      { action: "MISSION_HIDDEN", sentence: "hid a mission", target: missionName },
      { action: "MISSION_UNHIDDEN", sentence: "unhid a mission", target: missionName },
      { action: "MISSION_REMOVED", sentence: "removed a mission", target: missionName },
    ];
    for (const row of written) {
      await filterAuditLog(page, { action: row.action });
      await expect(pager(page, "entries")).toHaveText("Page 1 of 1 · 1 entries");
      // Scoped to the entry rather than asserted on the page, because the
      // topbar profile chip carries the signed-in admin's username too.
      const entry = auditEntry(page, row.target);
      await expect(entry).toContainText(admin.username);
      await expect(entry).toContainText("Admin");
      await expect(entry).toContainText(row.sentence);
    }

    // The role segments filter on the actor's role *as it was recorded*, so the
    // last row — an admin action — survives "Admins" and vanishes under
    // "Designers" without either filter touching `action` or `q`.
    await expect(page.getByLabel("Filter by action")).toHaveValue("MISSION_REMOVED");
    await filterAuditLog(page, { role: "Admins" });
    await expect(pager(page, "entries")).toHaveText("Page 1 of 1 · 1 entries");
    await filterAuditLog(page, { role: "Designers" });
    await expect(page.getByText("No actions match your filters.")).toBeVisible();

    // Every filter lives in the URL, so the whole narrowed view is a deep link.
    await expect(page).toHaveURL(
      new RegExp(`/admin/audit-log\\?role=DESIGNER&action=MISSION_REMOVED&q=${runId}$`),
    );
  });

  test("non-admins are turned away from the admin pages and the admin endpoints", async ({
    page,
    request,
  }) => {
    // Anonymous: the (app) layout's own `authGuard` half fires first.
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login$/);

    // A pilot is bounced to the pilot home, from every admin route.
    await signIn(page, pilot, /\/missions$/);
    for (const path of ["/admin/overview", "/admin/users", "/admin/missions", "/admin/audit-log"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/missions$/);
    }
    // …and never gets the section nav that would have offered them.
    await expect(page.getByRole("link", { name: "Audit Log" })).toHaveCount(0);

    // The guard is advisory; the endpoints behind it are the real rule. 403,
    // not 404 — the caller is authenticated, just not permitted.
    const asPilot = { headers: { Authorization: pilotAuth } };
    expect((await request.get("/api/v1/users", asPilot)).status()).toBe(403);
    expect((await request.get("/api/v1/missions/all", asPilot)).status()).toBe(403);
    expect((await request.get("/api/v1/audit-log", asPilot)).status()).toBe(403);
    expect((await request.post(`/api/v1/users/${adminId}/suspend`, asPilot)).status()).toBe(403);
    expect((await request.post(`/api/v1/users/${pilotId}/reactivate`, asPilot)).status()).toBe(403);
    expect(
      (await request.post("/api/v1/users/admins", { ...asPilot, data: secondAdmin })).status(),
    ).toBe(403);

    // A designer is bounced too — to *their* home, which is the branch that
    // separates `adminGuard` from its two single-destination siblings.
    await signIn(page, designer, /\/missions\/mine$/);
    await page.goto("/admin/audit-log");
    await expect(page).toHaveURL(/\/missions\/mine$/);

    // Anonymous callers never reach the role check at all.
    expect((await request.get("/api/v1/users")).status()).toBe(401);
    expect((await request.get("/api/v1/missions/all")).status()).toBe(401);
    expect((await request.get("/api/v1/audit-log")).status()).toBe(401);
  });
});
