import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";

/**
 * Playwright happy path for Phase 8 — the overdue sweep.
 *
 * The whole phase is one daily background job, so its only user-visible
 * outcome is a line in a pilot's notification bell: a mission they were
 * awarded whose flight window has closed earns exactly one "Has your flight
 * ended?" nudge, ever. This spec drives that end to end against the real
 * running app and the real database — seed an overdue awarded mission, sweep,
 * look at the bell as the pilot, sweep again, look again.
 *
 * Live-DB only, skipped with a visible reason when `DATABASE_URL` isn't
 * configured — the same `hasDb` convention as `e2e/lifecycle.spec.ts`,
 * `e2e/notifications.spec.ts` and the live-DB Vitest suites.
 * `playwright.config.ts` forwards `DATABASE_URL` from `.env.local`/`.env` into
 * `process.env`, which is both what this file reads and what it hands the
 * sweep process below.
 *
 * ## Why the sweep is triggered out of band
 * `src/lib/scheduler.ts` registers `runOverdueSweep()` for 09:00
 * Europe/Belgrade, and `src/instrumentation.ts` starts that scheduler inside
 * the very `next dev` server Playwright is driving. Waiting for 09:00 is not
 * an option, and reaching into the server process to fire its cron task early
 * would be a test of node-cron rather than of the sweep. So the job is run as
 * a one-shot child process against the *same* database
 * (`scripts/run-overdue-sweep.ts`, the same entry point the scheduler calls),
 * and the browser observes the result through the app. That the schedule
 * itself is the source's `0 9 * * *` in Europe/Belgrade, registered exactly
 * once, is covered by `src/lib/scheduler.test.ts`.
 *
 * ## Why the mission is nudged in SQL
 * A mission only becomes the sweep's business once it is AWARDED to a pilot
 * *and* its `endTime` has gone by — a state the public API cannot be talked
 * into producing in one step: the award arrives through the bid flow (Phase
 * 5's story, already covered by `e2e/lifecycle.spec.ts`, and one that would
 * raise a BID_ACCEPTED notification here and blur the bell assertions), and
 * "already over" is not something a designer creates. So the mission itself is
 * created through the real `POST /api/v1/missions`, and only the three columns
 * the sweep's predicate reads — `status`, `awarded_pilot_id`, `end_time` — are
 * set directly, exactly as `e2e/notifications.spec.ts` seeds the rows its own
 * phase has no API for. The pilot therefore starts with an empty bell, so
 * "the sweep notified them once" is the badge going 0 → 1 and staying there.
 *
 * Greenfield e2e coverage, not a JUnit/Angular port — the backend ships no
 * `OverdueNotificationSchedulerTest`. SOURCE (behaviour reference):
 * - drone-missions-backend/.../business/service/notification/OverdueNotificationScheduler.java
 *   — the sweep this exercises: AWARDED/IN_PROGRESS missions with a pilot and
 *   an `endTime` before the start of today, skipped when a MISSION_OVERDUE
 *   notification for that pilot and mission already exists.
 * - drone-missions-frontend/.../components/notification-bell/notification-bell.component.{ts,html}
 *   — the badge and the dropdown row the assertions below read.
 */
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * `src/lib/env.ts` requires `JWT_SECRET` unconditionally, and the sweep's
 * module graph parses that env singleton on import. The Playwright runner
 * process has no `.env.local` loaded (only `DATABASE_URL` is forwarded, see
 * `playwright.config.ts`), so the child process below is given the same
 * throwaway fixture the config hands `next dev`. It signs nothing: the sweep
 * issues no tokens.
 */
const E2E_JWT_SECRET = "e2e-playwright-fixture-secret-not-for-real-use-000000";

/** The copy `NewNotification.missionOverdue` produces, asserted verbatim. */
const OVERDUE_TITLE = "Has your flight ended?";
/**
 * The same title as a locator pattern. Written out rather than built from the
 * constant because the title ends in a `?`, which `new RegExp(OVERDUE_TITLE)`
 * would read as "the preceding `d` is optional" — a pattern that still matches
 * here, but only by accident.
 */
const OVERDUE_TITLE_PATTERN = /Has your flight ended\?/;
const overdueMessage = (missionName: string) =>
  `"${missionName}" has passed its end date. Mark it finished if the flight is done.`;

const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("Phase 8 overdue sweep happy path (live DB)", () => {
  test.skip(!DATABASE_URL, "DATABASE_URL not configured — see MIGRATION_PLAN.md §8");

  // Both tests read the same seeded mission and the second depends on the
  // first having swept, so this suite must run in declared order —
  // `playwright.config.ts` sets `fullyParallel: true`, which otherwise runs
  // same-file tests concurrently.
  test.describe.configure({ mode: "serial" });

  // Spawning a Node process that opens a pool, runs a query per overdue
  // mission and renders an email is slower than a page click; the sweep is
  // triggered twice across the suite.
  test.slow();

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = "password123";
  const pilot = {
    username: `overdue-pilot-${runId}`,
    email: `e2e-overdue-${runId}-pilot@example.com`,
    password,
  };
  const designer = {
    username: `overdue-designer-${runId}`,
    email: `e2e-overdue-${runId}-designer@example.com`,
    password,
  };

  /**
   * Unique per run: the sweep is database-wide by nature, so this suite shares
   * the bell with anything else the database holds, and only a name nothing
   * else can carry makes the "exactly one" assertions exact.
   */
  const missionName = `Ridge line inspection ${runId}`;

  /**
   * Direct connection for the SQL nudge and cleanup below — deliberately not
   * `src/db/client.ts`, which is `import "server-only"` and belongs to the app
   * process, not to this test runner.
   */
  let sql: postgres.Sql;
  let pilotId: number;
  let designerId: number;
  let missionId: number;

  // ---- fixtures ----

  async function register(
    api: APIRequestContext,
    account: { username: string; email: string; password: string },
    role: "PILOT" | "DESIGNER",
  ): Promise<void> {
    const response = await api.post("/api/v1/auth/register", { data: { ...account, role } });
    expect(response.status()).toBe(201);
  }

  /** Signs in over the API and returns the `Authorization` header to replay. */
  async function bearerFor(
    api: APIRequestContext,
    account: { email: string; password: string },
  ): Promise<string> {
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

  const promisifiedExecFile = promisify(execFile);

  /**
   * Runs one sweep, out of band, against the same database the app is using —
   * see the file header for why this is a child process rather than a nudge to
   * the running server.
   *
   * `node_modules/tsx/dist/cli.mjs` rather than `node_modules/.bin/tsx`: this
   * checkout installs with `package-import-method=copy` and no symlinks (see
   * `.npmrc`), which leaves the `.bin` entry a *copy* whose relative imports
   * no longer resolve. `--conditions=react-server` is what turns the
   * `import "server-only"` at the head of every service module into the no-op
   * it is on a real server instead of the guard throw it is everywhere else.
   */
  async function runSweep(): Promise<void> {
    const repoRoot = process.cwd();
    const { stderr } = await promisifiedExecFile(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        "--conditions=react-server",
        path.join(repoRoot, "scripts", "run-overdue-sweep.ts"),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL,
          JWT_SECRET: process.env.JWT_SECRET ?? E2E_JWT_SECRET,
          // Explicit rather than inherited: the sweep mails every pilot it
          // notifies, and a stray `MAIL_ENABLED=true` in the environment
          // would turn this suite into an outbound-mail client. Disabled, the
          // port still renders the template and logs what it would have sent.
          MAIL_ENABLED: "false",
        },
      },
    );
    // `runOverdueSweep` lets failures propagate (swallowing them is the cron
    // registration's job, not the job's), so a non-zero exit already rejects
    // above. This surfaces anything it merely complained about.
    expect(stderr).toBe("");
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    if (!DATABASE_URL) return;
    sql = postgres(DATABASE_URL, { max: 2 });

    const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    try {
      await register(api, pilot, "PILOT");
      await register(api, designer, "DESIGNER");
      pilotId = await userIdOf(pilot.email);
      designerId = await userIdOf(designer.email);

      // The mission is real, built through the endpoint a designer uses: two
      // waypoints is the minimum a flight path may have (`@Size(min = 2)`).
      const created = await api.post("/api/v1/missions", {
        headers: { Authorization: await bearerFor(api, designer) },
        data: {
          name: missionName,
          description: "Single pass along the ridge, 80 m, 4K.",
          status: "PUBLISHED",
          startTime: new Date(Date.now() + DAY_MS).toISOString(),
          endTime: new Date(Date.now() + 2 * DAY_MS).toISOString(),
          location: `Overdueville-${runId}`,
          biddingDeadline: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString().slice(0, 10),
          waypoints: [
            { lat: 44.8, lng: 20.45, altitude: 80, action: "PHOTO" },
            { lat: 44.81, lng: 20.46, altitude: 80, action: "PHOTO" },
          ],
          geofence: null,
        },
      });
      expect(created.status()).toBe(201);
      missionId = ((await created.json()) as { id: number }).id;
      expect(missionId).toBeGreaterThan(0);
    } finally {
      await api.dispose();
    }

    // The nudge (see the file header): awarded to the pilot, and finished two
    // days ago — comfortably before the start of today in Europe/Belgrade
    // whatever offset the zone is on, so the case never depends on the hour
    // the suite runs at.
    const endedAt = new Date(Date.now() - 2 * DAY_MS);
    await sql`
      update mission
         set status = 'AWARDED',
             awarded_pilot_id = ${pilotId},
             start_time = ${new Date(endedAt.getTime() - DAY_MS)},
             end_time = ${endedAt},
             updated_at = ${new Date()}
       where id = ${missionId}
    `;
  });

  test.afterAll(async () => {
    if (!sql) return;
    // Ordered by FK: everything pointing at the two throwaway accounts goes
    // first. `audit_log` is on that list because registering, signing in and
    // creating the mission write entries, and `fk_audit_log_actor` deliberately
    // has no cascade (see `src/db/schema.ts`: history must never be erasable
    // through a user row) — so those rows have to be cleared explicitly or the
    // account delete below fails with a 23503.
    const actorIds = [pilotId, designerId].filter(Boolean);
    if (pilotId) await sql`delete from notification where user_id = ${pilotId}`;
    if (missionId) await sql`delete from mission where id = ${missionId}`;
    if (actorIds.length > 0) await sql`delete from audit_log where actor_id in ${sql(actorIds)}`;
    await sql`delete from users where email in (${pilot.email}, ${designer.email})`;
    await sql.end();
  });

  // ---- page helpers (same shapes as e2e/notifications.spec.ts) ----

  /** The topbar bell button — `aria-label="Notifications"` in the component. */
  function bell(page: Page): Locator {
    return page.getByRole("button", { name: "Notifications" });
  }

  /** The unread badge: the bell button's only `<span>` child, absent at zero. */
  function badge(page: Page): Locator {
    return bell(page).locator("span");
  }

  /** Every "Has your flight ended?" row currently in the open dropdown. */
  function overdueRows(page: Page): Locator {
    return page.getByRole("button", { name: OVERDUE_TITLE_PATTERN });
  }

  /** Signs the pilot in through the real login form and waits for their home. */
  async function signInAsPilot(page: Page): Promise<void> {
    await page.goto("/login");
    await page.getByLabel("Email").fill(pilot.email);
    await page.getByLabel("Password").fill(pilot.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/missions$/);
  }

  /**
   * The server's own unread figure for the signed-in pilot
   * (`GET /api/v1/notifications/unread-count` → `{"count": n}`), read with the
   * JWT `auth.client.ts` stored under `dm_token`. Cross-checked against the
   * badge so a passing assertion proves the sweep really wrote a row, rather
   * than the client having rendered something optimistically.
   */
  async function serverUnreadCount(page: Page): Promise<number> {
    const token = await page.evaluate(() => window.localStorage.getItem("dm_token"));
    const response = await page.request.get("/api/v1/notifications/unread-count", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(200);
    return ((await response.json()) as { count: number }).count;
  }

  test("one sweep run tells the pilot their flight window has closed", async ({ page }) => {
    // Before: the seeded mission is overdue but nobody has been told, so the
    // pilot's bell is empty — which is what makes the badge below the sweep's
    // doing and nothing else's.
    await signInAsPilot(page);
    await expect(bell(page)).toBeVisible();
    await expect(badge(page)).toHaveCount(0);
    expect(await serverUnreadCount(page)).toBe(0);

    await runSweep();

    await page.reload();
    await expect(badge(page)).toHaveText("1");
    expect(await serverUnreadCount(page)).toBe(1);

    await bell(page).click();
    await expect(overdueRows(page)).toHaveCount(1);
    // The copy the pilot actually reads, naming their mission.
    await expect(overdueRows(page)).toContainText(overdueMessage(missionName));
  });

  test("a second sweep run over the same mission adds nothing", async ({ page }) => {
    // `overdueExists` is the guard the daily schedule depends on: without it
    // every 09:00 run would nag the same pilot about the same mission again.
    await runSweep();

    await signInAsPilot(page);
    // Still one, and still unread — the first run's row was never touched.
    await expect(badge(page)).toHaveText("1");
    expect(await serverUnreadCount(page)).toBe(1);

    await bell(page).click();
    await expect(overdueRows(page)).toHaveCount(1);

    // And the database agrees: one MISSION_OVERDUE row for this pilot and this
    // mission after two sweeps, not two rows the panel happened to collapse.
    const rows = await sql<{ title: string }[]>`
      select title from notification
       where user_id = ${pilotId} and mission_id = ${missionId} and type = 'MISSION_OVERDUE'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe(OVERDUE_TITLE);
  });
});
