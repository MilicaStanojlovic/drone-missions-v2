import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";

/**
 * Playwright happy-path e2e for Phase 9 — Platform stats dashboard.
 *
 * Drives the real running app against the local Postgres started by
 * `docker compose up db` (see `MIGRATION_PLAN.md` §8) through the one story
 * this phase ships: an admin signs in, opens `/admin/overview`, and the page
 * that has rendered "Couldn't load the platform stats" ever since Phase 7 put
 * it there now paints a real census — six tiles, seven status bars, the
 * bids-per-mission chart and the user-base split, every number matching what
 * `GET /api/v1/platform-stats` itself reports. The last test is the negative
 * half: a pilot is bounced off the page and refused by the endpoint behind it.
 *
 * Live-DB only, skipped with a visible reason when `DATABASE_URL` isn't
 * configured — the same `hasDb` convention as `e2e/admin.spec.ts`,
 * `e2e/ratings.spec.ts` and the live-DB Vitest suites. `playwright.config.ts`
 * forwards `DATABASE_URL` from `.env.local`/`.env` (or a real CI secret) into
 * `process.env` for this file to read, and resolves `PORT` the same way, so
 * nothing here hardcodes a port.
 *
 * Greenfield e2e coverage, not a JUnit/Angular port. SOURCE (behaviour
 * reference): `admin-overview.component.{ts,html}` — its one `getOverview()`
 * call on init, the three mutually exclusive body states, and the derived
 * values the tiles show (`totalMissions` is a *sum* of the status map, bid
 * volume is `$` + thousands separators, the average is `—` at zero bids); plus
 * `PlatformStatsController.overview`'s `hasRole('ADMIN')` and the `adminGuard`
 * in front of the route.
 *
 * ## Nothing is hardcoded, and nothing is approximate
 *
 * Every number on this page is a **platform-wide** aggregate, so unlike the
 * neighbouring specs this one cannot scope its assertions to its own rows with
 * a `runId`: whatever else the database holds is inside every tile. The
 * expected values are therefore read from the endpoint itself, in the test, and
 * the rendered page is asserted to equal them exactly — which is what "accurate
 * tiles" has to mean on a shared database. That the endpoint's own arithmetic
 * is right is pinned separately and exhaustively by
 * `src/app/api/v1/platform-stats/routes.live.test.ts` (foreign aggregates +
 * fixture, to the cent); what this spec adds is the other half: that the
 * browser renders those numbers, in the right places, through the real guard,
 * with no error state.
 *
 * Reading the expectation from the same endpoint would be circular if the page
 * could pass while showing *nothing* — so `beforeAll` seeds a fixture that puts
 * a known floor under the census (six missions across five statuses, three
 * bids, a suspended pilot), and `the overview reports the platform's real
 * numbers` asserts that floor is inside the totals before comparing the DOM to
 * them. A dashboard stuck at zero, or one drawing an empty chart, fails.
 *
 * ## Why the snapshot is bracketed
 *
 * `playwright.config.ts` sets `fullyParallel: true`, so the other specs are
 * inserting users, missions and bids in neighbouring workers the whole time,
 * and a global count read a second before the page loads may not be the count
 * the page loaded. `stableOverview` therefore reads the endpoint, loads the
 * page, and reads the endpoint again, keeping the pair only when it did not
 * move — the same bracket-and-retry the live route suite uses for the same
 * reason. Assertions run after the second read because this page fetches
 * exactly once, on mount: the DOM is frozen by then, so a snapshot proven
 * stable around the load is the one it is showing.
 *
 * **Why the admin account is minted here rather than taken from V12.** The plan
 * offers the migration-seeded `admin@drone-missions.local`, but V12 seeds only
 * a BCrypt *hash* — a dev credential whose plaintext is recorded nowhere in
 * either repo — so no spec can sign in as that account. Registration refuses to
 * mint an ADMIN by design (`AuthService.register`), so this suite does what
 * `e2e/admin.spec.ts` already does and documents: register through the real
 * public endpoint, then promote with one `update users set role = 'ADMIN'`,
 * which is exactly how V12 itself creates the first admin. The V12 row is still
 * asserted to exist, because everything here depends on that migration having
 * widened `users_role_check` to accept ADMIN at all.
 */
const DATABASE_URL = process.env.DATABASE_URL;

/** A user this suite registers and drives. */
interface Account {
  username: string;
  email: string;
  password: string;
  role: "DESIGNER" | "PILOT";
}

/**
 * The two shapes `GET /api/v1/platform-stats` answers with, declared here
 * rather than imported from `src/features/stats/stats.types.ts`: every spec in
 * `e2e/` is black-box and self-contained (none of them imports app code), which
 * is what keeps them runnable against a deployed build. A drift between this
 * declaration and the server's is caught by the assertions below, which compare
 * the rendered page against these fields by name.
 */
type MissionStatusName =
  "DRAFT" | "PUBLISHED" | "BIDDING" | "AWARDED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

type UserRoleName = "DESIGNER" | "PILOT" | "ADMIN";

/** One bar of the bids-per-mission chart. */
interface TopMission {
  name: string;
  bids: number;
}

interface PlatformStats {
  missionsByStatus: Record<MissionStatusName, number>;
  activePilots: number;
  bidCount: number;
  bidAmountTotal: number;
  suspendedUsers: number;
  usersByRole: Record<UserRoleName, number>;
  topMissionsByBids: TopMission[];
}

/**
 * Every status the bars iterate, in render order, with the label its row
 * carries. Mirrors `MISSION_STATUSES` + `MISSION_STATUS_LABELS`
 * (`mission.client.ts`, itself a port of `models/mission.model.ts`) — the
 * status map is zero-filled over exactly this set, so the seven rows are also
 * the assertion that the service zero-filled it.
 */
const STATUS_LABELS: Record<MissionStatusName, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  BIDDING: "Bidding",
  AWARDED: "Awarded",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

test.describe("Phase 9 platform stats happy path (live DB)", () => {
  test.skip(!DATABASE_URL, "DATABASE_URL not configured — see MIGRATION_PLAN.md §8");

  // `playwright.config.ts` sets `fullyParallel: true`, which would otherwise
  // run these same-file tests concurrently — and the second one suspends an
  // account the first one counts.
  test.describe.configure({ mode: "serial" });

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = "password123";

  /** Promoted to ADMIN before it ever signs in — see the file header. */
  const admin: Account = {
    username: `stat-admin-${runId}`,
    email: `e2e-stat-${runId}-admin@example.com`,
    password,
    role: "PILOT",
  };
  /** Owns every seeded mission. */
  const designer: Account = {
    username: `stat-designer-${runId}`,
    email: `e2e-stat-${runId}-designer@example.com`,
    password,
    role: "DESIGNER",
  };
  /** Bids on both open missions, and stays active. */
  const pilot: Account = {
    username: `stat-pilot-${runId}`,
    email: `e2e-stat-${runId}-pilot@example.com`,
    password,
    role: "PILOT",
  };
  /** Bids once, then is suspended — the gap between `activePilots` and `usersByRole.PILOT`. */
  const suspendedPilot: Account = {
    username: `stat-suspended-${runId}`,
    email: `e2e-stat-${runId}-suspended@example.com`,
    password,
    role: "PILOT",
  };

  /**
   * The fixture's own contribution to the census, seeded through the real
   * public API. Five statuses are represented (a bid flips PUBLISHED to
   * BIDDING, so `busy` and `quiet` land there), which is what puts a non-zero
   * count under most of the seven bars whatever else the database holds; the
   * two bid-carrying missions are what guarantee the chart is not empty.
   *
   * `bids` are the amounts placed on that mission, at most one per pilot
   * (`BidService.place` allows a pilot only one bid per mission), with cents so
   * the volume tile exercises the `sum(numeric)` narrowing end to end.
   */
  const seeded: { label: string; status: MissionStatusName; bids: number[] }[] = [
    { label: "draft", status: "DRAFT", bids: [] },
    { label: "open", status: "PUBLISHED", bids: [] },
    { label: "busy", status: "PUBLISHED", bids: [1200.5, 950.25] },
    { label: "quiet", status: "PUBLISHED", bids: [2000] },
    { label: "done", status: "COMPLETED", bids: [] },
    { label: "off", status: "CANCELLED", bids: [] },
  ];

  /** What the seeded rows must add to each aggregate — the floor asserted below. */
  const seededMissionsByStatus: Partial<Record<MissionStatusName, number>> = {
    DRAFT: 1,
    PUBLISHED: 1,
    BIDDING: 2,
    COMPLETED: 1,
    CANCELLED: 1,
  };
  const seededBidCount = seeded.reduce((total, mission) => total + mission.bids.length, 0);

  /**
   * Direct connection for the ADMIN promotion and the cleanup below —
   * deliberately not `src/db/client.ts`, which is `import "server-only"` and
   * belongs to the app process, not to this test runner. Same reasoning as
   * `e2e/admin.spec.ts`.
   */
  let sql: postgres.Sql;
  /** Shared request context for the fixtures; disposed in `afterAll`. */
  let api: APIRequestContext;

  /** Replayed to read the endpoint's own answer as the page's caller would. */
  let adminAuth = "";
  let pilotAuth = "";
  let designerId = 0;
  let adminId = 0;
  let suspendedPilotId = 0;

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

  /**
   * One seeded mission, created in the status asked for. `missionRequestSchema`
   * accepts every `MissionStatus` and `MissionService.create` writes it through
   * untouched, so a COMPLETED or CANCELLED bucket is one POST rather than a
   * status column poked behind the service's back — the same technique the
   * live route suite uses to seed its census.
   */
  async function createMission(
    designerAuth: string,
    label: string,
    status: MissionStatusName,
  ): Promise<number> {
    const created = await api.post("/api/v1/missions", {
      headers: { Authorization: designerAuth },
      data: {
        name: `Stats ${label} survey ${runId}`,
        description: "Platform-stats fixture: two passes at 60 m.",
        status,
        startTime: daysFromNow(3).toISOString(),
        endTime: daysFromNow(9).toISOString(),
        location: `Statsville-${runId}`,
        biddingDeadline: isoDay(daysFromNow(2)),
        // `@Size(min = 2)` — the shortest flight path the validator allows.
        waypoints: [
          { lat: 44.8, lng: 20.45, altitude: 60, action: "PHOTO" },
          { lat: 44.81, lng: 20.46, altitude: 60, action: "PHOTO" },
        ],
        geofence: null,
      },
    });
    expect(created.status()).toBe(201);
    const body = (await created.json()) as { id: number; status: string };
    expect(body.status).toBe(status);
    return body.id;
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
    // migrations stopped short — and it is the row that makes `usersByRole`
    // carry an ADMIN bucket in the first place.
    const migrationSeeded = await sql<{ role: string }[]>`
      select role from users where email = 'admin@drone-missions.local'
    `;
    expect(migrationSeeded[0]?.role).toBe("ADMIN");

    await registerViaApi(admin);
    await registerViaApi(designer);
    await registerViaApi(pilot);
    await registerViaApi(suspendedPilot);

    adminId = await userIdOf(admin.email);
    designerId = await userIdOf(designer.email);
    suspendedPilotId = await userIdOf(suspendedPilot.email);

    // The promotion (see the file header). It must happen before the first
    // sign-in: the role travels in the JWT, so a token minted while this
    // account was still a PILOT would keep behaving like one.
    await sql`update users set role = 'ADMIN', updated_at = now() where id = ${adminId}`;

    adminAuth = await bearerFor(admin);
    pilotAuth = await bearerFor(pilot);
    const designerAuth = await bearerFor(designer);
    const suspendedPilotAuth = await bearerFor(suspendedPilot);
    const bidders = [pilotAuth, suspendedPilotAuth];

    for (const mission of seeded) {
      const missionId = await createMission(designerAuth, mission.label, mission.status);
      for (const [index, amount] of mission.bids.entries()) {
        // 200, not 201: the endpoint updates an existing bid as readily as it
        // creates one, and the source returns `ResponseEntity.ok(...)` for both.
        const placed = await api.post(`/api/v1/bids/mission/${missionId}`, {
          headers: { Authorization: bidders[index] },
          data: { amount, message: `Stats fixture bid ${index + 1} — ${runId}` },
        });
        expect(placed.status()).toBe(200);
      }
    }

    // Suspended *after* bidding, because a suspended pilot may not place one —
    // and the suspension is what separates `activePilots` from
    // `usersByRole.PILOT`, which the tiles show side by side.
    const suspended = await api.post(`/api/v1/users/${suspendedPilotId}/suspend`, {
      headers: { Authorization: adminAuth },
    });
    expect(suspended.status()).toBe(200);
  });

  test.afterAll(async () => {
    await api?.dispose();
    if (!sql) {
      return;
    }
    // Ordered by FK, as `e2e/admin.spec.ts` documents: the missions go first
    // (V15 cascades their bids and notifications away with them), then the
    // audit rows the suspension wrote — `audit_log` has no cascade on its actor,
    // history must never be erasable through a user row — then the accounts.
    const emails = [admin.email, designer.email, pilot.email, suspendedPilot.email];
    if (designerId) {
      await sql`delete from mission where user_id = ${designerId}`;
    }
    await sql`
      delete from audit_log
       where actor_id in (select id from users where email in ${sql(emails)})
    `;
    await sql`delete from users where email in ${sql(emails)}`;
    await sql.end();
  });

  // ---- account helpers (the real login form — see e2e/ratings.spec.ts) ----

  /** Signs in and waits for the role home `landingGuard` redirects to. */
  async function signIn(page: Page, account: { email: string; password: string }, home: RegExp) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(home);
  }

  // ---- page helpers ----

  /**
   * One stat tile's number, found by the label underneath it: the tile is a
   * value `div` followed by its label `div`, so the label is the stable handle
   * and the number is its immediately preceding sibling.
   */
  function tileValue(page: Page, label: string): Locator {
    return page.getByText(label, { exact: true }).locator("xpath=preceding-sibling::div[1]");
  }

  /**
   * One bar row — a status row of MISSIONS BY STATUS or a role row of USER
   * BASE, which share a shape: `<span>label</span><div track><div fill/></div>
   * <span>count</span>`. The label span's parent is the row.
   */
  function barRow(page: Page, label: string): Locator {
    return page.getByText(label, { exact: true }).locator("xpath=..");
  }

  /** The right-hand count of a bar row. */
  function barCount(page: Page, label: string): Locator {
    return barRow(page, label).locator("span").last();
  }

  /**
   * The coloured fill inside a bar row's track — present only when the bucket
   * is non-empty, which is the source's `@if (… > 0)` around the fill div (an
   * empty bucket draws no hairline at all).
   */
  function barFill(page: Page, label: string): Locator {
    return barRow(page, label).locator("div div");
  }

  /** The BIDS PER MISSION card (the panel title's parent). */
  function chartPanel(page: Page): Locator {
    return page.getByText("BIDS PER MISSION").locator("xpath=..");
  }

  /**
   * The chart as rendered, in DOM order: each column's full mission name (the
   * `title` the truncated label carries) and the count above its bar. Read in
   * one pass so the comparison below is a single `toEqual` against the
   * endpoint's list — which pins the order, the values and the cap together.
   */
  function renderedChart(page: Page): Promise<TopMission[]> {
    return chartPanel(page)
      .locator("span[title]")
      .evaluateAll((labels) =>
        labels.map((label) => ({
          name: label.getAttribute("title") ?? "",
          // The column's first span is the count above the bar.
          bids: Number(label.parentElement?.querySelector("span")?.textContent ?? "NaN"),
        })),
      );
  }

  // ---- the endpoint's own answer ----

  /** `GET /api/v1/platform-stats` as the page's own fetch sees it. */
  async function apiOverview(): Promise<PlatformStats> {
    const response = await api.get("/api/v1/platform-stats", {
      headers: { Authorization: adminAuth },
    });
    expect(response.status()).toBe(200);
    return (await response.json()) as PlatformStats;
  }

  /**
   * Loads `/admin/overview` and returns the snapshot it is showing: the
   * endpoint read before and after the load, kept only when the two agree (see
   * the file header on why the bracket is needed at all). Retried a few times,
   * because a neighbouring worker landing a row mid-read is ordinary, not a
   * failure.
   */
  async function stableOverview(page: Page): Promise<PlatformStats> {
    const attempts = 4;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const before = await apiOverview();

      await page.goto("/admin/overview");
      // The tiles appearing *is* the proof the loading state resolved into the
      // stats branch rather than the error one.
      await expect(page.getByText("Total missions", { exact: true })).toBeVisible();

      const after = await apiOverview();
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return before;
      }
    }
    throw new Error(
      `the platform counts never held still across ${attempts} loads — another suite is writing heavily`,
    );
  }

  // ---- the tests ----

  test("the overview reports the platform's real numbers, tile for tile", async ({ page }) => {
    await signIn(page, admin, /\/admin\/overview$/);
    const stats = await stableOverview(page);

    // Neither state the source's other two branches render: the page got its
    // snapshot, so "Loading stats…" is gone and "Couldn't load" — the branch
    // this page has shown since Phase 7 put it there without an endpoint — is
    // not on the page at all.
    await expect(page.getByText("Loading stats…")).toHaveCount(0);
    await expect(page.getByText("Couldn't load the platform stats. Please try again.")).toHaveCount(
      0,
    );
    await expect(page.getByRole("heading", { name: "Platform Overview" })).toBeVisible();

    // The fixture is inside the totals. Reading the expectation from the same
    // endpoint the page calls would otherwise let an all-zero dashboard pass
    // (see the file header); these bounds are what make the numbers below
    // demonstrably real rows rather than a shape that merely agrees with itself.
    for (const [status, count] of Object.entries(seededMissionsByStatus)) {
      expect(stats.missionsByStatus[status as MissionStatusName]).toBeGreaterThanOrEqual(count);
    }
    expect(stats.bidCount).toBeGreaterThanOrEqual(seededBidCount);
    expect(stats.bidAmountTotal).toBeGreaterThanOrEqual(4150.75);
    expect(stats.usersByRole.DESIGNER).toBeGreaterThanOrEqual(1);
    // Two pilots registered, one of them suspended — so the suspension shows up
    // as exactly the gap between these two counts.
    expect(stats.usersByRole.PILOT).toBeGreaterThanOrEqual(2);
    expect(stats.activePilots).toBeGreaterThanOrEqual(1);
    expect(stats.suspendedUsers).toBeGreaterThanOrEqual(1);
    expect(stats.topMissionsByBids.length).toBeGreaterThan(0);
    // The chart's cap, as `stats.service.ts` sets it (`TOP_MISSIONS = 6`).
    expect(stats.topMissionsByBids.length).toBeLessThanOrEqual(6);

    // The six tiles. The first is a *sum* of the status map, not a field —
    // `totalMissions` in the source — and the two money tiles are the source's
    // own formatting, including its deliberate asymmetry: the volume goes
    // through `toLocaleString`, the average does not.
    const totalMissions = Object.values(stats.missionsByStatus).reduce((a, b) => a + b, 0);
    const bidVolumeText = "$" + Math.round(stats.bidAmountTotal).toLocaleString("en-US");
    const avgBidText =
      stats.bidCount === 0 ? "—" : "$" + Math.round(stats.bidAmountTotal / stats.bidCount);

    await expect(tileValue(page, "Total missions")).toHaveText(String(totalMissions));
    await expect(tileValue(page, "Active pilots")).toHaveText(String(stats.activePilots));
    await expect(tileValue(page, "Suspended")).toHaveText(String(stats.suspendedUsers));
    await expect(tileValue(page, "Total bids")).toHaveText(String(stats.bidCount));
    await expect(tileValue(page, "Bid volume")).toHaveText(bidVolumeText);
    await expect(tileValue(page, "Avg bid")).toHaveText(avgBidText);
  });

  test("the status bars, the bid chart and the user split carry the same snapshot", async ({
    page,
  }) => {
    await signIn(page, admin, /\/admin\/overview$/);
    const stats = await stableOverview(page);

    // All seven statuses have a row, including the ones no mission is in: the
    // map arrives zero-filled, so a bucket with nothing in it reads "0" rather
    // than going missing. Its track stays empty, which is the source's
    // `@if (… > 0)` around the fill.
    for (const [status, label] of Object.entries(STATUS_LABELS)) {
      const count = stats.missionsByStatus[status as MissionStatusName];
      expect(count, `${status} missing from the status map`).toBeGreaterThanOrEqual(0);
      await expect(barCount(page, label)).toHaveText(String(count));
      await expect(barFill(page, label)).toHaveCount(count > 0 ? 1 : 0);
    }

    // BIDS PER MISSION: the endpoint's list, in the endpoint's order, with the
    // full mission name on each column's `title` — so this covers the cap, the
    // descending order and the per-bar counts in one comparison. Comparing the
    // order itself is safe because `topMissionsByBids` breaks ties by mission
    // id (see `bid.queries.ts`), so two reads of the same rows come back in the
    // same order rather than reshuffling equal counts.
    await expect(chartPanel(page).getByText("No bids yet")).toHaveCount(0);
    expect(await renderedChart(page)).toEqual(stats.topMissionsByBids);

    // USER BASE draws only the two marketplace roles, though the ADMIN bucket
    // the map also carries is inside the share each bar is drawn against.
    await expect(barCount(page, "Designers")).toHaveText(String(stats.usersByRole.DESIGNER));
    await expect(barCount(page, "Pilots")).toHaveText(String(stats.usersByRole.PILOT));
    await expect(barFill(page, "Designers")).toHaveCount(stats.usersByRole.DESIGNER > 0 ? 1 : 0);
    await expect(barFill(page, "Pilots")).toHaveCount(stats.usersByRole.PILOT > 0 ? 1 : 0);
  });

  test("non-admins get neither the overview page nor the endpoint behind it", async ({
    page,
    request,
  }) => {
    // Anonymous: the (app) layout's own `authGuard` half fires first…
    await page.goto("/admin/overview");
    await expect(page).toHaveURL(/\/login$/);
    // …and the endpoint never reaches the role check at all (`src/middleware.ts`).
    expect((await request.get("/api/v1/platform-stats")).status()).toBe(401);

    // A pilot is bounced to the pilot home, and never gets the nav entry that
    // would have offered the page.
    await signIn(page, pilot, /\/missions$/);
    await page.goto("/admin/overview");
    await expect(page).toHaveURL(/\/missions$/);
    await expect(page.getByRole("link", { name: "Overview" })).toHaveCount(0);
    await expect(page.getByText("Platform Overview")).toHaveCount(0);

    // The guard is advisory; the endpoint behind it is the real rule. 403, not
    // 404 — the caller is authenticated, just not permitted.
    const asPilot = { headers: { Authorization: pilotAuth } };
    expect((await request.get("/api/v1/platform-stats", asPilot)).status()).toBe(403);

    // A designer is refused the same way — the check is on ADMIN, not on "not a
    // pilot" — and lands on *their* home, the branch that separates `adminGuard`
    // from its single-destination siblings.
    await signIn(page, designer, /\/missions\/mine$/);
    await page.goto("/admin/overview");
    await expect(page).toHaveURL(/\/missions\/mine$/);
    const asDesigner = { headers: { Authorization: await bearerFor(designer) } };
    expect((await request.get("/api/v1/platform-stats", asDesigner)).status()).toBe(403);
  });
});
