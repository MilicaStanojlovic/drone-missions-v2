import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";

/**
 * Playwright happy-path e2e for Phase 4 — Notifications + Email.
 *
 * Drives the real running app (login page, the `(app)` shell's topbar, the
 * notification bell and its dropdown, the real `/api/v1/notifications/**`
 * routes) against the Postgres named by `DATABASE_URL` — this worktree's
 * `dronemissions_p4` on `PORT=3001`, both taken from `.env.local` by
 * `playwright.config.ts`. Skipped, with a visible reason, when no database is
 * configured, exactly like `e2e/auth.spec.ts` and the live-DB Vitest suites.
 *
 * Greenfield e2e coverage, not a JUnit/Angular port — there is no single
 * source test to mirror. SOURCE (behavior reference):
 * - drone-missions-frontend/.../components/notification-bell/notification-bell.component.{ts,html}
 *   — badge (`count > 9 ? '9+' : count`), backdrop, "Mark all read" shown only
 *   while unread, "You're all caught up." empty state, `onSelect`'s
 *   markRead + navigate (`/missions/{id}`, or `/missions` for BID_REJECTED).
 * - drone-missions-frontend/.../app.component.html — `@if (auth.isPilot)`
 *   around `<app-notification-bell />`, i.e. designers get no bell at all.
 * - drone-missions-backend/.../web/controller/notification/NotificationController.java
 *   — the `/unread-count` figure this spec cross-checks the badge against, so
 *   a passing badge assertion also proves the read actually persisted rather
 *   than only having been applied optimistically in the client.
 *
 * Seeding is raw SQL against the same database (per the phase plan: this
 * phase ships no missions feature module, so mission rows must not come from
 * a `features/missions` import). The two accounts are created through the
 * real `POST /api/v1/auth/register`, because the pilot then signs in through
 * the real login form and needs a real password hash.
 *
 * Route coverage note — `/missions/{id}` has no page yet (Phase 2 adds it),
 * so the "open the mission" step asserts the URL the bell navigated to, which
 * is the whole of the bell's own contribution; the destination page lands
 * with the missions phase.
 *
 * The phase's other "done when" — an email renders and is logged instead of
 * sent while `MAIL_ENABLED=false` — is not observable through the browser
 * (nothing in this phase's UI triggers a send; Phase 5's bid/lifecycle
 * transitions do). It is covered by `tests/lib/email/email.service.test.ts`,
 * which renders each template and asserts the `[mail disabled] would send
 * to=... subject=...` pino line carries the rendered HTML.
 */
const DATABASE_URL = process.env.DATABASE_URL;

test.describe("Phase 4 notifications happy path (live DB)", () => {
  test.skip(!DATABASE_URL, "DATABASE_URL not configured — see MIGRATION_PLAN.md §8");

  // Every test drives the same seeded rows, and the read-marking ones mutate
  // them, so this suite must run in declared order — `playwright.config.ts`
  // sets `fullyParallel: true`, which otherwise runs same-file tests
  // concurrently.
  test.describe.configure({ mode: "serial" });

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = "password123";
  const pilot = {
    username: `notif-pilot-${runId}`,
    email: `e2e-notif-${runId}-pilot@example.com`,
    password,
  };
  const designer = {
    username: `notif-designer-${runId}`,
    email: `e2e-notif-${runId}-designer@example.com`,
    password,
  };

  /**
   * Direct connection for the SQL seeding/cleanup below — deliberately not
   * `src/db/client.ts`, which is `import "server-only"` and belongs to the
   * app process, not to this test runner.
   */
  let sql: postgres.Sql;
  let pilotId: number;
  let designerId: number;
  let missionId: number;

  /** Copy the service's `NewNotification` factories produce, seeded verbatim. */
  const bidAccepted = {
    title: "Bid accepted",
    message: (name: string) => `Your bid on "${name}" was accepted — the mission is yours.`,
  };
  const bidRejected = {
    title: "Bid not selected",
    message: (name: string) => `Your bid on "${name}" wasn't selected.`,
  };
  const missionOverdue = {
    title: "Has your flight ended?",
    message: (name: string) =>
      `"${name}" has passed its end date. Mark it finished if the flight is done.`,
  };

  const missionName = `E2E Notification Survey ${runId}`;
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  /** Registers an account through the real public endpoint. */
  async function register(
    api: APIRequestContext,
    account: { username: string; email: string; password: string },
    role: "PILOT" | "DESIGNER",
  ) {
    const response = await api.post("/api/v1/auth/register", {
      data: { ...account, role },
    });
    expect(response.status()).toBe(201);
  }

  /** Looks a seeded account's id up by email (bigint arrives as a string). */
  async function userIdOf(email: string): Promise<number> {
    const rows = await sql<{ id: string }[]>`select id from users where email = ${email}`;
    return Number(rows[0].id);
  }

  async function seedNotification(values: {
    type: "BID_ACCEPTED" | "BID_REJECTED" | "MISSION_OVERDUE" | "MISSION_CANCELLED";
    title: string;
    message: string;
    createdAt: Date;
    readAt?: Date | null;
  }) {
    const now = new Date();
    await sql`
      insert into notification (user_id, type, title, message, mission_id, read_at, created_at, updated_at)
      values (${pilotId}, ${values.type}, ${values.title}, ${values.message}, ${missionId},
              ${values.readAt ?? null}, ${values.createdAt}, ${now})
    `;
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    if (!DATABASE_URL) return;
    sql = postgres(DATABASE_URL, { max: 2 });

    const api = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
    });
    try {
      await register(api, pilot, "PILOT");
      await register(api, designer, "DESIGNER");
    } finally {
      await api.dispose();
    }

    pilotId = await userIdOf(pilot.email);
    designerId = await userIdOf(designer.email);

    // Minimal mission row: the NOT NULL columns plus the two fields a
    // notification actually reads back (`id`, `name`).
    const now = new Date();
    const [row] = await sql<{ id: string }[]>`
      insert into mission (name, status, user_id, created_at, updated_at)
      values (${missionName}, 'AWARDED', ${designerId}, ${now}, ${now})
      returning id
    `;
    missionId = Number(row.id);

    // Two unread + one already-read, with distinct creation times so the
    // panel's newest-first order is observable.
    await seedNotification({
      type: "BID_ACCEPTED",
      title: bidAccepted.title,
      message: bidAccepted.message(missionName),
      createdAt: minutesAgo(2),
    });
    await seedNotification({
      type: "BID_REJECTED",
      title: bidRejected.title,
      message: bidRejected.message(missionName),
      createdAt: minutesAgo(3 * 60),
    });
    await seedNotification({
      type: "MISSION_OVERDUE",
      title: missionOverdue.title,
      message: missionOverdue.message(missionName),
      createdAt: minutesAgo(2 * 24 * 60),
      readAt: minutesAgo(24 * 60),
    });
  });

  test.afterAll(async () => {
    if (!sql) return;
    // Ordered by FK: everything pointing at the two throwaway accounts goes
    // first. `audit_log` is on that list because registering and signing in
    // write REGISTER/LOGIN entries, and `fk_audit_log_actor` deliberately has
    // no cascade (see `src/db/schema.ts`: history must never be erasable
    // through a user row) — so the audit trail this run created has to be
    // cleared explicitly or the account delete below fails with a 23503.
    const actorIds = [pilotId, designerId].filter(Boolean);
    if (pilotId) await sql`delete from notification where user_id = ${pilotId}`;
    if (missionId) await sql`delete from mission where id = ${missionId}`;
    if (actorIds.length > 0) await sql`delete from audit_log where actor_id in ${sql(actorIds)}`;
    await sql`delete from users where email in (${pilot.email}, ${designer.email})`;
    await sql.end();
  });

  /** The topbar bell button — `aria-label="Notifications"` in the component. */
  function bell(page: Page): Locator {
    return page.getByRole("button", { name: "Notifications" });
  }

  /** The unread badge: the button's only `<span>` child, absent at zero. */
  function badge(page: Page): Locator {
    return bell(page).locator("span");
  }

  /** Signs in through the real login form and waits for the role home. */
  async function signIn(
    page: Page,
    account: { email: string; password: string },
    home: RegExp,
  ): Promise<void> {
    await page.goto("/login");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(home);
  }

  /**
   * Waits for the `POST /api/v1/notifications/{id}/read` a row click fires.
   * Awaited explicitly because that click also navigates away, and the
   * request must be allowed to land before the read is checked for.
   */
  function waitForMarkRead(page: Page) {
    return page.waitForResponse(
      (response) =>
        /\/api\/v1\/notifications\/\d+\/read$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
  }

  /**
   * The server's own unread figure for the signed-in caller
   * (`GET /api/v1/notifications/unread-count` → `{"count": n}`), read with
   * the JWT `auth.client.ts` stored under `dm_token`. Used to prove a read
   * was persisted, not merely applied optimistically in the client.
   */
  async function serverUnreadCount(page: Page): Promise<number> {
    const token = await page.evaluate(() => window.localStorage.getItem("dm_token"));
    const response = await page.request.get("/api/v1/notifications/unread-count", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { count: number };
    return body.count;
  }

  test("the pilot's topbar bell badges the seeded unread count", async ({ page }) => {
    await signIn(page, pilot, /\/missions$/);

    await expect(bell(page)).toBeVisible();
    // Two of the three seeded rows are unread; the third was seeded read.
    await expect(badge(page)).toHaveText("2");
    expect(await serverUnreadCount(page)).toBe(2);
  });

  test("the dropdown lists the notifications newest-first with title, message and relative time", async ({
    page,
  }) => {
    await signIn(page, pilot, /\/missions$/);
    await bell(page).click();

    // Panel header (the bell button itself is labelled, not titled, so this
    // text node is the panel's own heading).
    await expect(page.getByText("Notifications", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark all read" })).toBeVisible();
    await expect(page.getByText("You're all caught up.")).toHaveCount(0);

    const rows = page.getByRole("button", { name: /ago$/ });
    await expect(rows).toHaveCount(3);
    // Newest first: 2m -> 3h -> 2d, `NotificationRepository`'s
    // `findByUser_IdOrderByCreatedAtDesc` order, rendered through `timeAgo`.
    await expect(rows.nth(0)).toContainText(bidAccepted.title);
    // Minutes, not an exact "2m ago": the row was seeded two minutes back and
    // the clock keeps running while the suite does.
    await expect(rows.nth(0)).toContainText(/\d+m ago/);
    await expect(rows.nth(1)).toContainText(bidRejected.title);
    await expect(rows.nth(1)).toContainText("3h ago");
    await expect(rows.nth(2)).toContainText(missionOverdue.title);
    await expect(rows.nth(2)).toContainText("2d ago");

    // The mission's name is interpolated into every message body.
    await expect(rows.nth(0)).toContainText(bidAccepted.message(missionName));

    // Backdrop click closes the panel (component's `bell__backdrop`).
    await page.mouse.click(5, 400);
    await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);
  });

  test("clicking the rejected-bid row marks it read, drops the badge and lands on /missions", async ({
    page,
  }) => {
    await signIn(page, pilot, /\/missions$/);
    await bell(page).click();

    const markedRead = waitForMarkRead(page);
    await page.getByRole("button", { name: new RegExp(bidRejected.title) }).click();
    expect((await markedRead).status()).toBe(204);

    // BID_REJECTED never links to the mission — the pilot can no longer see
    // it — so the row navigates to the feed instead.
    await expect(page).toHaveURL(/\/missions$/);
    await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);
    await expect(badge(page)).toHaveText("1");
    await expect.poll(() => serverUnreadCount(page)).toBe(1);
  });

  test("clicking the accepted-bid row navigates to that mission and clears the last unread", async ({
    page,
  }) => {
    await signIn(page, pilot, /\/missions$/);
    await bell(page).click();
    await expect(badge(page)).toHaveText("1");

    const markedRead = waitForMarkRead(page);
    await page.getByRole("button", { name: new RegExp(bidAccepted.title) }).click();
    expect((await markedRead).status()).toBe(204);

    // A mission-linked notification opens that mission. The page itself
    // arrives with Phase 2; the bell's contract is the destination.
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}$`));
    await expect.poll(() => serverUnreadCount(page)).toBe(0);
  });

  test("with everything read the badge is gone and the panel still lists the history", async ({
    page,
  }) => {
    await signIn(page, pilot, /\/missions$/);
    await expect(bell(page)).toBeVisible();
    await expect(badge(page)).toHaveCount(0);

    await bell(page).click();
    await expect(page.getByRole("button", { name: /ago$/ })).toHaveCount(3);
    // "Mark all read" is bound to `unreadCount > 0`, so it disappears here.
    await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);
  });

  test("'Mark all read' zeroes the badge", async ({ page }) => {
    await seedNotification({
      type: "MISSION_CANCELLED",
      title: "Mission cancelled",
      message: `"${missionName}" was cancelled by the designer.`,
      createdAt: minutesAgo(1),
    });
    await seedNotification({
      type: "MISSION_OVERDUE",
      title: missionOverdue.title,
      message: missionOverdue.message(missionName),
      createdAt: minutesAgo(4),
    });

    await signIn(page, pilot, /\/missions$/);
    await expect(badge(page)).toHaveText("2");

    await bell(page).click();
    await page.getByRole("button", { name: "Mark all read" }).click();

    await expect(badge(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);
    // The panel stays open (unlike a row click) and now shows five read rows.
    await expect(page.getByRole("button", { name: /ago$/ })).toHaveCount(5);
    await expect.poll(() => serverUnreadCount(page)).toBe(0);
  });

  test("a designer never sees the bell", async ({ page }) => {
    await signIn(page, designer, /\/missions\/mine$/);

    // The shell really did mount for them (profile chip is rendered) — so the
    // bell's absence is the `@if (auth.isPilot)` gate, not an unrendered page.
    await expect(page.getByText(designer.username, { exact: true })).toBeVisible();
    await expect(page.getByText("Mission Designer", { exact: true })).toBeVisible();
    await expect(bell(page)).toHaveCount(0);
  });
});
