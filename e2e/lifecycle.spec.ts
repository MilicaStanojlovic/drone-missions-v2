import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Playwright happy-path e2e for Phase 5 — Acceptance + Mission lifecycle.
 *
 * Drives the real running app against the local Postgres started by
 * `docker compose up db` (see `MIGRATION_PLAN.md` §8) through the whole award
 * and lifecycle story this phase ships: a designer awards one of two competing
 * bids, the winner and the loser are each told what happened, the winner finds
 * the job on `/my-jobs`, starts it and marks it finished — and, in the second
 * scenario, a designer cancels a mission that had already been awarded, which
 * rejects the accepted bid and notifies the pilot who had won it.
 *
 * Live-DB only, skipped with a visible reason when `DATABASE_URL` isn't
 * configured — the same `hasDb` convention as `e2e/bids.spec.ts`,
 * `e2e/missions.spec.ts` and the live-DB Vitest suites. `playwright.config.ts`
 * forwards `DATABASE_URL` from `.env.local`/`.env` (or a real CI secret) into
 * `process.env` for this file to read.
 *
 * Greenfield e2e coverage, not a JUnit/Angular port — there is no single source
 * test to mirror. SOURCE (behaviour reference): the flows ported by this
 * phase's earlier tasks —
 * - `BidService.accept` (the designer's award: the winning bid ACCEPTED, every
 *   other PENDING bid on the mission REJECTED, the mission AWARDED to that
 *   pilot, then a notification + email to the winner and to each loser);
 * - `MissionService.start` / `complete` / `cancel` / `findAwardedTo` (the
 *   awarded pilot's two deliberate transitions, the owner's cancel — which
 *   rejects PENDING *and* ACCEPTED bids and notifies the awarded pilot — and
 *   the `/my-jobs` listing);
 * - `mission-detail.component.{ts,html}` (`isWinner`/`canStart`/`canCancel`,
 *   `askAccept`/`askStart`/`askComplete`/`askCancel` and their toasts) and the
 *   `bid--accepted` / "This bid was not accepted" bid styling.
 *
 * **The "no lazy IN_PROGRESS" guard.** `plans/PLAN-lifecycle.md` opens with a
 * flagged discrepancy: the phase spec claims `AWARDED → IN_PROGRESS` is applied
 * server-side once `startTime` has passed, but the Spring source has no such
 * path — `IN_PROGRESS` is only ever written by the explicit `start()`. That is
 * a claim about what *reads* do, so it is pinned here rather than in a unit
 * test: the awarded mission below is deliberately created with a `startTime`
 * **in the past**, and one whole test does nothing but read it — through the
 * detail page, the jobs list and the API — asserting it is still AWARDED
 * afterwards. If a lazy transition were ever added, that test fails.
 *
 * Steps build on each other (award → notify → start → complete → cancel), so
 * the suite runs serially and shares its two mission ids between tests; each
 * test signs its user in through the real login form, exactly as
 * `e2e/bids.spec.ts` does, because every test gets a fresh browser context (and
 * so an empty `localStorage`).
 *
 * The three accounts, the two missions and the three bids they compete with are
 * fixtures, so they are created through the real public API in `beforeAll`
 * rather than through the planner and bid form: building a flight plan by
 * clicking the Leaflet canvas is Phase 2 behaviour and placing a bid is Phase
 * 3's, both already covered end-to-end by their own specs, and repeating them
 * here would spend the run's slowest steps on something this phase does not
 * change. Everything this phase *does* ship is driven through the browser.
 * Going through the API (rather than seeding SQL, as `e2e/notifications.spec.ts`
 * must) also keeps this spec runnable against any deployment, with no direct
 * database access of its own.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/** A user this suite registers and drives. */
interface Account {
  username: string;
  email: string;
  password: string;
  role: "DESIGNER" | "PILOT";
}

test.describe("Phase 5 acceptance + lifecycle happy path (live DB)", () => {
  test.skip(!hasDb, "DATABASE_URL not configured — see MIGRATION_PLAN.md §8");

  // `playwright.config.ts` sets `fullyParallel: true`, which would otherwise
  // run these same-file tests concurrently.
  test.describe.configure({ mode: "serial" });

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = "password123";
  const designer: Account = {
    username: `life-designer-${runId}`,
    email: `e2e-life-${runId}-designer@example.com`,
    password,
    role: "DESIGNER",
  };
  /** The pilot whose bid is accepted, who then starts and finishes the job. */
  const winner: Account = {
    username: `life-winner-${runId}`,
    email: `e2e-life-${runId}-winner@example.com`,
    password,
    role: "PILOT",
  };
  /** The pilot whose bid the award rejects — the "other bids" half of accept. */
  const loser: Account = {
    username: `life-loser-${runId}`,
    email: `e2e-life-${runId}-loser@example.com`,
    password,
    role: "PILOT",
  };

  /**
   * Unique per run: this suite shares its database with every other run, and
   * the feed, `/my-jobs` and the notification panel are all lists, so only a
   * name/location nothing else can carry makes the assertions below exact.
   */
  const awardMissionName = `Reservoir mapping ${runId}`;
  const awardMissionLocation = `Awardville-${runId}`;
  const cancelMissionName = `Quarry survey ${runId}`;
  const cancelMissionLocation = `Cancelford-${runId}`;

  const winningAmount = 400;
  const losingAmount = 520;
  const winningMessage = "LiDAR rig on the truck, can fly the whole shoreline in one go.";
  const losingMessage = "Available all week, two-person crew.";

  /** Set by `beforeAll`, read by every test. */
  let awardMissionId = 0;
  let cancelMissionId = 0;
  /** The bid on `cancelMissionId` the cancel scenario awards over the API. */
  let cancelMissionBidId = 0;
  /** Bearer tokens the fixtures (and the cancel scenario's award) replay. */
  let designerAuth = "";
  /** Shared request context for the fixtures; disposed in `afterAll`. */
  let api: APIRequestContext;

  // ---- fixtures (the real public API — see the file header) ----

  function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  /**
   * `yyyy-MM-dd`, the wire form of the `LocalDate` `biddingDeadline`. Relative
   * to the run rather than hardcoded, because a bid is refused outright once
   * the deadline has gone by (`BidService.place`) — a fixed date would quietly
   * turn this suite into a "bidding is closed" test the day it went by.
   */
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
  async function bearerFor(account: Account): Promise<string> {
    const login = await api.post("/api/v1/auth/login", {
      data: { email: account.email, password: account.password },
    });
    expect(login.status()).toBe(200);
    // The JWT arrives in the response header (see the login route), not the body.
    const authorization = login.headers()["authorization"];
    expect(authorization).toBeTruthy();
    return authorization;
  }

  /**
   * A PUBLISHED mission owned by the designer. PUBLISHED, not DRAFT: only a
   * published (or already bidding) mission is open for bids. The two waypoints
   * are the minimum a flight path may have (`@Size(min = 2)`).
   */
  async function createMissionViaApi(values: {
    name: string;
    location: string;
    startTime: Date;
    endTime: Date;
  }): Promise<number> {
    const created = await api.post("/api/v1/missions", {
      headers: { Authorization: designerAuth },
      data: {
        name: values.name,
        description: "Two passes at 60 m, 4K plus thermal.",
        status: "PUBLISHED",
        startTime: values.startTime.toISOString(),
        endTime: values.endTime.toISOString(),
        location: values.location,
        biddingDeadline: isoDay(daysFromNow(5)),
        waypoints: [
          { lat: 44.8, lng: 20.45, altitude: 60, action: "PHOTO" },
          { lat: 44.81, lng: 20.46, altitude: 60, action: "PHOTO" },
        ],
        geofence: null,
      },
    });
    expect(created.status()).toBe(201);
    const id = ((await created.json()) as { id: number }).id;
    expect(id).toBeGreaterThan(0);
    return id;
  }

  /**
   * Places one pilot's bid and answers its id. 200, not 201: the same endpoint
   * updates an existing bid as often as it creates one, and the source returns
   * `ResponseEntity.ok(...)` for both (see the route's own note).
   */
  async function placeBidViaApi(
    account: Account,
    missionId: number,
    amount: number,
    message: string,
  ): Promise<number> {
    const placed = await api.post(`/api/v1/bids/mission/${missionId}`, {
      headers: { Authorization: await bearerFor(account) },
      data: { amount, message },
    });
    expect(placed.status()).toBe(200);
    return ((await placed.json()) as { id: number }).id;
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    if (!hasDb) {
      return;
    }
    api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });

    await registerViaApi(designer);
    await registerViaApi(winner);
    await registerViaApi(loser);
    designerAuth = await bearerFor(designer);

    // The awarded mission's flight window has ALREADY OPENED (startTime
    // yesterday). That is what makes the "reads never advance a status" test
    // below meaningful — see the file header's note on the flagged
    // AWARDED -> IN_PROGRESS discrepancy.
    awardMissionId = await createMissionViaApi({
      name: awardMissionName,
      location: awardMissionLocation,
      startTime: daysFromNow(-1),
      endTime: daysFromNow(6),
    });
    cancelMissionId = await createMissionViaApi({
      name: cancelMissionName,
      location: cancelMissionLocation,
      startTime: daysFromNow(7),
      endTime: daysFromNow(14),
    });

    // Two pilots compete for the awarded mission; only the winner bids on the
    // one that gets cancelled (the cancel path cares about the *accepted* bid).
    await placeBidViaApi(winner, awardMissionId, winningAmount, winningMessage);
    await placeBidViaApi(loser, awardMissionId, losingAmount, losingMessage);
    cancelMissionBidId = await placeBidViaApi(winner, cancelMissionId, 300, "Happy to take this.");
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  // ---- account helpers (the real login form — see e2e/bids.spec.ts) ----

  /** Signs in and waits for the role home `landingGuard` redirects to. */
  async function signIn(page: Page, account: Account): Promise<void> {
    await page.goto("/login");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(account.role === "DESIGNER" ? /\/missions\/mine$/ : /\/missions$/);
  }

  // ---- page helpers ----

  /** A mission card in the feed / dashboard / jobs grid, found by its title. */
  function missionCard(page: Page, name: string): Locator {
    return page.locator('a[href^="/missions/"]').filter({ hasText: name });
  }

  /**
   * One bid's name-and-tag row in the designer's panel: the innermost `div`
   * carrying that pilot's name, which is exactly the one holding their
   * ACCEPTED / REJECTED tag (`.last()` because ancestors sort before
   * descendants in DOM order — the same idiom `e2e/bids.spec.ts` uses).
   */
  function bidRow(page: Page, pilotName: string): Locator {
    return page.locator("div").filter({ hasText: pilotName }).last();
  }

  /** The transient status message `useToast` raises (`role="status"`). */
  function toast(page: Page): Locator {
    return page.getByRole("status");
  }

  /**
   * The confirm dialog. Every lifecycle action is scoped through it once it is
   * open, because two of the three dialogs repeat the page button's own wording
   * on their confirm ("Start mission", "Cancel mission") — an unscoped
   * `getByRole` would then match both.
   */
  function dialog(page: Page): Locator {
    return page.getByRole("alertdialog");
  }

  /**
   * The number on one tile of the `/my-jobs` counts strip: the tile is the
   * `div` whose direct child carries the label, and its first child is the
   * figure.
   */
  function jobCount(page: Page, label: string): Locator {
    return page.locator(`div:has(> div:text-is("${label}")) > div`).first();
  }

  /** The topbar bell button — `aria-label="Notifications"` in the component. */
  function bell(page: Page): Locator {
    return page.getByRole("button", { name: "Notifications" });
  }

  /** The unread badge: the bell button's only `<span>` child, absent at zero. */
  function badge(page: Page): Locator {
    return bell(page).locator("span");
  }

  /**
   * Waits for the `POST /api/v1/notifications/{id}/read` a row click fires.
   * Awaited explicitly because that click also navigates away, and the request
   * must be allowed to land before the navigation is checked for.
   */
  function waitForMarkRead(page: Page) {
    return page.waitForResponse(
      (response) =>
        /\/api\/v1\/notifications\/\d+\/read$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
  }

  /**
   * The mission's status **as the server reports it**, read with the JWT
   * `auth.client.ts` stored under `dm_token`. The UI's own status badge shares
   * its wording with the lifecycle timeline beside it, so this is both the
   * unambiguous assertion and — being a plain GET — the very read the "no lazy
   * transition" test needs to prove changes nothing.
   */
  async function serverStatus(page: Page, missionId: number): Promise<string> {
    const token = await page.evaluate(() => window.localStorage.getItem("dm_token"));
    const response = await page.request.get(`/api/v1/missions/${missionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(200);
    return ((await response.json()) as { status: string }).status;
  }

  test("the designer awards the mission and every other bid is rejected", async ({ page }) => {
    await signIn(page, designer); // DESIGNER home is My Missions

    await missionCard(page, awardMissionName).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${awardMissionId}$`));
    await expect(page.getByRole("heading", { name: awardMissionName })).toBeVisible();

    // The owner's face of the aside: both bids, both still up for grabs, so
    // both carry an Accept button and neither carries a decision tag.
    await expect(page.getByText("2 bids", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Accept / })).toHaveCount(2);
    await expect(page.getByText("ACCEPTED", { exact: true })).toHaveCount(0);
    await expect(page.getByText("REJECTED", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: new RegExp(`^Accept ${winner.username}`) }).click();

    // The confirm the source puts in front of an irreversible award, quoting
    // who and how much before anything is written.
    await expect(dialog(page)).toContainText("Accept this bid?");
    await expect(dialog(page)).toContainText(winner.username);
    await expect(dialog(page)).toContainText(`$${winningAmount}`);
    await dialog(page).getByRole("button", { name: "Accept bid" }).click();

    await expect(toast(page)).toHaveText(`Awarded to ${winner.username} — other bids rejected`);

    // `onChanged` re-read mission and bids in place, so the whole cascade
    // `BidService.accept` performed in one transaction is visible without a
    // navigation: this bid ACCEPTED, the other REJECTED…
    await expect(bidRow(page, winner.username)).toContainText("ACCEPTED");
    await expect(bidRow(page, loser.username)).toContainText("REJECTED");
    // …and the mission itself AWARDED, which is what withdraws every Accept
    // button (`hasAward`) rather than leaving one that would now 409.
    await expect(page.getByRole("button", { name: /^Accept / })).toHaveCount(0);
    expect(await serverStatus(page, awardMissionId)).toBe("AWARDED");
  });

  test("the winning pilot is notified and finds the job on My Jobs", async ({ page }) => {
    await signIn(page, winner); // PILOT home is the feed itself

    await expect(badge(page)).toHaveText("1");
    await bell(page).click();
    const accepted = page.getByRole("button", { name: /Bid accepted/ });
    await expect(accepted).toContainText(
      `Your bid on "${awardMissionName}" was accepted — the mission is yours.`,
    );

    // A mission-linked notification opens that mission, and reading it clears
    // the badge.
    const markedRead = waitForMarkRead(page);
    await accepted.click();
    expect((await markedRead).status()).toBe(204);
    await expect(page).toHaveURL(new RegExp(`/missions/${awardMissionId}$`));
    await expect(badge(page)).toHaveCount(0);

    // The winner's own face of the aside: their bid marked won, the finish
    // block offering the start, and no bid form at all — an AWARDED mission is
    // no longer biddable (`canBid`).
    await expect(page.getByText("✓ You won this mission", { exact: true })).toBeVisible();
    await expect(page.getByText("You won this mission", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start mission" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Place bid" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Update bid" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Withdraw bid" })).toHaveCount(0);

    // Reached the way a pilot reaches it: the topbar link only pilots get.
    await page.getByRole("link", { name: "My Jobs" }).click();
    await expect(page).toHaveURL(/\/my-jobs$/);
    await expect(missionCard(page, awardMissionName)).toContainText("Awarded");
    // The counts strip, computed from the same list: one job, waiting to start.
    await expect(jobCount(page, "To start")).toHaveText("1");
  });

  test("the losing pilot is told, and the mission leaves their feed", async ({ page }) => {
    await signIn(page, loser);

    await expect(badge(page)).toHaveText("1");
    await bell(page).click();
    const rejected = page.getByRole("button", { name: /Bid not selected/ });
    await expect(rejected).toContainText(`Your bid on "${awardMissionName}" wasn't selected.`);

    // BID_REJECTED never links to the mission — the pilot has no stake in it
    // any more — so the row navigates to the feed instead.
    const markedRead = waitForMarkRead(page);
    await rejected.click();
    expect((await markedRead).status()).toBe(204);
    await expect(page).toHaveURL(/\/missions$/);

    // And the mission is gone from that feed: `OPEN_STATUSES` is
    // PUBLISHED/BIDDING, so awarding it closed the marketplace listing.
    await page.getByLabel("Filter by location").fill(awardMissionLocation);
    // The empty state, not merely a missing card: it is what proves the
    // filtered request came back at all.
    await expect(page.getByText("No missions match your filters")).toBeVisible();
    await expect(missionCard(page, awardMissionName)).toHaveCount(0);

    // Their own bid is still readable on the mission, marked as passed over.
    await page.goto(`/missions/${awardMissionId}`);
    await expect(page.getByText("This bid was not accepted")).toBeVisible();
    await expect(page.getByText(`$${losingAmount}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Start mission" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Withdraw bid" })).toHaveCount(0);

    // A rejected bid is not a job.
    await page.goto("/my-jobs");
    await expect(page.getByText("No jobs yet")).toBeVisible();
    await expect(missionCard(page, awardMissionName)).toHaveCount(0);
  });

  test("reading an overdue awarded mission never advances it to IN_PROGRESS", async ({ page }) => {
    // The guard for this phase's flagged plan-vs-source discrepancy (see the
    // file header): this mission's `startTime` was yesterday, and the source
    // has no code that promotes a mission on read — only the pilot's explicit
    // Start does, which has not happened yet.
    await signIn(page, winner);
    expect(await serverStatus(page, awardMissionId)).toBe("AWARDED");

    // Every read path the app offers, twice over: the detail page (both roles
    // load it), the jobs list, the API itself.
    await page.goto(`/missions/${awardMissionId}`);
    await expect(page.getByRole("button", { name: "Start mission" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Start mission" })).toBeVisible();
    await page.goto("/my-jobs");
    await expect(missionCard(page, awardMissionName)).toContainText("Awarded");
    expect(await serverStatus(page, awardMissionId)).toBe("AWARDED");

    // The owner's reads are just as inert.
    await signIn(page, designer);
    await page.goto(`/missions/${awardMissionId}`);
    await expect(page.getByRole("heading", { name: awardMissionName })).toBeVisible();
    await page.goto("/missions/mine");
    await expect(missionCard(page, awardMissionName)).toContainText("Awarded");
    expect(await serverStatus(page, awardMissionId)).toBe("AWARDED");
  });

  test("the winner starts the job from My Jobs and marks it finished", async ({ page }) => {
    await signIn(page, winner);
    await page.goto("/my-jobs");

    // The card carries `?from=my-jobs`, which is what makes Back return to the
    // jobs list rather than the feed.
    await missionCard(page, awardMissionName).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${awardMissionId}\\?from=my-jobs$`));

    await page.getByRole("button", { name: "Start mission" }).click();
    await expect(dialog(page)).toContainText("Start this mission?");
    await dialog(page).getByRole("button", { name: "Start mission" }).click();

    await expect(toast(page)).toHaveText("Mission started");
    // `refresh()` re-read the mission, so the finish block swapped in place.
    await expect(page.getByText("Your mission is underway")).toBeVisible();
    expect(await serverStatus(page, awardMissionId)).toBe("IN_PROGRESS");

    await page.getByRole("button", { name: "Mark mission finished" }).click();
    await expect(dialog(page)).toContainText("Mark mission finished?");
    await dialog(page).getByRole("button", { name: "Yes, it's finished" }).click();

    await expect(toast(page)).toHaveText("Mission marked as completed");
    await expect(page.getByText("✓ Mission completed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark mission finished" })).toHaveCount(0);
    expect(await serverStatus(page, awardMissionId)).toBe("COMPLETED");

    // COMPLETED is terminal, and reading it keeps it that way.
    await page.getByRole("button", { name: "← Back to my jobs" }).click();
    await expect(page).toHaveURL(/\/my-jobs$/);
    await expect(missionCard(page, awardMissionName)).toContainText("Completed");
    expect(await serverStatus(page, awardMissionId)).toBe("COMPLETED");
  });

  test("the designer cancels an awarded mission and its accepted bid is rejected", async ({
    page,
  }) => {
    // The second mission is awarded over the API — the award flow itself is
    // what the first test drives through the browser, and repeating it here
    // would only lengthen the run. Cancel is what this test is about.
    const accept = await api.post(`/api/v1/bids/${cancelMissionBidId}/accept`, {
      headers: { Authorization: designerAuth },
    });
    expect(accept.status()).toBe(200);

    await signIn(page, designer);
    await page.goto(`/missions/${cancelMissionId}`);
    await expect(bidRow(page, winner.username)).toContainText("ACCEPTED");

    // Unambiguous while the dialog is shut — the confirm it opens repeats this
    // wording, which is why the confirmation below is scoped to the dialog.
    await page.getByRole("button", { name: "Cancel mission" }).click();
    await expect(dialog(page)).toContainText("Cancel this mission?");
    await dialog(page).getByRole("button", { name: "Cancel mission" }).click();

    await expect(toast(page)).toHaveText("Mission cancelled");
    // CANCELLED is an exit, not a step, so `MISSION_LIFECYCLE` (and the
    // timeline built from it) never names it — this chip is the status badge.
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    expect(await serverStatus(page, cancelMissionId)).toBe("CANCELLED");

    // `MissionService.cancel` rejects PENDING *and* ACCEPTED bids in the same
    // transaction, so the award is undone rather than left dangling…
    await expect(bidRow(page, winner.username)).toContainText("REJECTED");
    await expect(page.getByText("ACCEPTED", { exact: true })).toHaveCount(0);
    // …and a cancelled mission cannot be cancelled again (`canCancel`).
    await expect(page.getByRole("button", { name: "Cancel mission" })).toHaveCount(0);
  });

  test("the awarded pilot is notified that the mission was cancelled", async ({ page }) => {
    await signIn(page, winner);

    // Two unread: the BID_ACCEPTED the API award above raised, and the
    // MISSION_CANCELLED the cancel raised on top of it.
    await expect(badge(page)).toHaveText("2");
    await bell(page).click();
    const cancelled = page.getByRole("button", { name: /Mission cancelled/ });
    await expect(cancelled).toContainText(`"${cancelMissionName}" was cancelled by the designer.`);

    const markedRead = waitForMarkRead(page);
    await cancelled.click();
    expect((await markedRead).status()).toBe(204);
    await expect(page).toHaveURL(new RegExp(`/missions/${cancelMissionId}$`));

    // Their bid on it went back to being a bid that lost, and there is nothing
    // left to start.
    await expect(page.getByText("This bid was not accepted")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start mission" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark mission finished" })).toHaveCount(0);

    // The job stays listed — `findByAwardedPilotId` filters no status, so the
    // pilot keeps seeing what became of the work they won.
    await page.goto("/my-jobs");
    await expect(missionCard(page, cancelMissionName)).toContainText("Cancelled");
    await expect(missionCard(page, awardMissionName)).toContainText("Completed");
    await expect(jobCount(page, "To start")).toHaveText("0");
    await expect(jobCount(page, "Completed")).toHaveText("1");
  });
});
