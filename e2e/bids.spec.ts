import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Playwright happy-path e2e for Phase 3 — Bids.
 *
 * Drives the real running app against the local Postgres started by
 * `docker compose up db` (see `MIGRATION_PLAN.md` §8) through the whole bid
 * lifecycle this phase ships: a pilot places the first bid on a published
 * mission (which flips it to BIDDING), updates it, finds it on `/my-bids`,
 * walks the `from=my-bids` back link to the detail, is seen by the designer
 * in the mission's bids panel, and finally withdraws it — after which it is
 * gone from every one of those places.
 *
 * Live-DB only, skipped with a visible reason when `DATABASE_URL` isn't
 * configured — the same `hasDb` convention as `e2e/missions.spec.ts`,
 * `e2e/auth.spec.ts` and the live-DB Vitest suites.
 * `playwright.config.ts` forwards `DATABASE_URL` from `.env.local`/`.env`
 * (or a real CI secret) into `process.env` for this file to read.
 *
 * Greenfield e2e coverage, not a JUnit/Angular port — there is no single
 * source test to mirror. SOURCE (behaviour reference): the Angular flows
 * ported by this phase's earlier tasks — the `<aside class="panel">` half of
 * `mission-detail.component.{ts,html}` (`myBid`, `canBid`, `placeBid`,
 * `withdrawBid`, `bidCountText`, the `from=my-bids` back target) and
 * `my-bids.component.{ts,html}` (rows, chips, per-row withdraw) — plus
 * `BidService`, whose rules the assertions below pin:
 * - the first bid on a PUBLISHED mission writes it back as BIDDING;
 * - one bid per pilot per mission (`bid_mission_pilot_unique`), so a second
 *   place() *updates* rather than adding a row;
 * - `listForMission` gives the owning designer every bid and everyone else
 *   only their own.
 *
 * Two client-side rules of the panel are pinned as well, both the source's:
 * - **blank means keep** — an empty amount box on an update keeps the current
 *   price, which is what makes the message-only edit below leave $450 alone;
 * - the designer gets **no Accept affordance at all** in this phase (the award
 *   flow is Phase 5), so the button is absent rather than disabled.
 *
 * Steps build on each other (place -> update -> list -> withdraw), so the
 * suite runs serially and shares `missionId` between tests; each test signs
 * its user in through the real login form, exactly as `e2e/missions.spec.ts`
 * does, because every test gets a fresh browser context (and so an empty
 * `localStorage`).
 *
 * The two accounts and the mission they bid on are fixtures, so they are
 * created through the real public API in `beforeAll` rather than through the
 * planner UI: building a flight plan by clicking the Leaflet canvas is Phase
 * 2 behaviour, already covered end-to-end by `e2e/missions.spec.ts`, and
 * repeating it here would spend the run's slowest, flakiest steps on
 * something this phase does not change. Everything this phase *does* ship is
 * driven through the browser. Going through the API (rather than seeding SQL,
 * as `e2e/notifications.spec.ts` must) also keeps this spec runnable against
 * any deployment, with no direct database access of its own.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/** A user this suite registers and drives. */
interface Account {
  username: string;
  email: string;
  password: string;
  role: "DESIGNER" | "PILOT";
}

test.describe("Phase 3 bids happy path (live DB)", () => {
  test.skip(!hasDb, "DATABASE_URL not configured — see MIGRATION_PLAN.md §8");

  // `playwright.config.ts` sets `fullyParallel: true`, which would otherwise
  // run these same-file tests concurrently.
  test.describe.configure({ mode: "serial" });

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = "password123";
  const designer: Account = {
    username: `bids-designer-${runId}`,
    email: `e2e-bids-${runId}-designer@example.com`,
    password,
    role: "DESIGNER",
  };
  const pilot: Account = {
    username: `bids-pilot-${runId}`,
    email: `e2e-bids-${runId}-pilot@example.com`,
    password,
    role: "PILOT",
  };

  /**
   * Unique per run: this suite shares its database with every other run, and
   * both the feed and `/my-bids` are lists, so only a name/location nothing
   * else can carry makes the assertions below exact.
   */
  const missionName = `Bridge deck inspection ${runId}`;
  const missionLocation = `Bidville-${runId}`;

  /** The bid the pilot places, then edits. The amount survives the edit. */
  const bidAmount = 450;
  const bidMessage = "Certified thermal rig — can fly the whole span in one sortie.";
  const editedMessage = "Rescheduled: Monday works better for the span closure.";

  /** Set by `beforeAll`, read by every test. */
  let missionId = 0;

  // ---- fixtures (the real public API — see the file header) ----

  function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  /**
   * `yyyy-MM-dd`, the wire form of the `LocalDate` `biddingDeadline`. Relative
   * to the run rather than hardcoded, because the deadline is exactly what
   * decides whether the panel offers a bid form at all (`canBid`) — a fixed
   * date would quietly turn this suite into a "bidding is closed" test the day
   * it went by.
   */
  function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  async function registerViaApi(api: APIRequestContext, account: Account): Promise<void> {
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
  async function bearerFor(api: APIRequestContext, account: Account): Promise<string> {
    const login = await api.post("/api/v1/auth/login", {
      data: { email: account.email, password: account.password },
    });
    expect(login.status()).toBe(200);
    // The JWT arrives in the response header (see the login route), not the body.
    const authorization = login.headers()["authorization"];
    expect(authorization).toBeTruthy();
    return authorization;
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    if (!hasDb) {
      return;
    }
    const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    try {
      await registerViaApi(api, designer);
      await registerViaApi(api, pilot);

      // PUBLISHED, not DRAFT: only a published (or already bidding) mission is
      // open for bids, and only those reach the pilot's feed. The two
      // waypoints are the minimum a flight path may have (`@Size(min = 2)`).
      const created = await api.post("/api/v1/missions", {
        headers: { Authorization: await bearerFor(api, designer) },
        data: {
          name: missionName,
          description: "Two passes over the north span, 4K plus thermal.",
          status: "PUBLISHED",
          startTime: daysFromNow(7).toISOString(),
          endTime: daysFromNow(14).toISOString(),
          location: missionLocation,
          biddingDeadline: isoDay(daysFromNow(5)),
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
    } finally {
      await api.dispose();
    }
  });

  // ---- account helpers (the real login form — see e2e/missions.spec.ts) ----

  /** Signs in and waits for the role home `landingGuard` redirects to. */
  async function signIn(page: Page, account: Account): Promise<void> {
    await page.goto("/login");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(account.role === "DESIGNER" ? /\/missions\/mine$/ : /\/missions$/);
  }

  // ---- page helpers ----

  /** A mission card in the feed / dashboard grid, found by its title. */
  function missionCard(page: Page, name: string): Locator {
    return page.locator('a[href^="/missions/"]').filter({ hasText: name });
  }

  /** The pilot's own bid card on the detail page ("Current bid" + amount). */
  function myBidCard(page: Page): Locator {
    return page
      .locator("div")
      .filter({ hasText: /^Current bid/ })
      .first();
  }

  /**
   * The value of the "Bids" telemetry tile. The tile is a label `<div>` next
   * to a value `<div>`; `div:text-is('Bids')` picks the label alone and not
   * the designer panel's identically-worded title, which is a `<span>`.
   */
  function bidsTileValue(page: Page): Locator {
    return page.locator("div:text-is('Bids') + div");
  }

  /** The transient status message `useToast` raises (`role="status"`). */
  function toast(page: Page): Locator {
    return page.getByRole("status");
  }

  test("a pilot's first bid lands on the mission and flips it to BIDDING", async ({ page }) => {
    await signIn(page, pilot); // PILOT home is the feed itself

    await page.goto(`/missions/${missionId}`);
    await expect(page.getByRole("heading", { name: missionName })).toBeVisible();

    // The pilot's face of the aside, with nothing bid yet: the form, no bid card.
    await expect(page.getByText("Your bid", { exact: true })).toBeVisible();
    await expect(page.getByText("Current bid")).toHaveCount(0);
    await expect(bidsTileValue(page)).toHaveText("0");

    await page.getByLabel("Your bid (USD)").fill(String(bidAmount));
    await page.getByLabel("Message (optional)").fill(bidMessage);
    await page.getByRole("button", { name: "Place bid" }).click();

    await expect(toast(page)).toHaveText(`Bid placed — $${bidAmount}`);

    // `onChanged` re-read mission and bids in place, so the bid card, the
    // telemetry tile and the form's "update" wording all arrive without a
    // navigation.
    await expect(myBidCard(page)).toContainText(`$${bidAmount}`);
    await expect(page.getByText(`“${bidMessage}”`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw bid" })).toBeVisible();
    await expect(bidsTileValue(page)).toHaveText("1");
    await expect(page.getByRole("button", { name: "Update bid" })).toBeVisible();

    // The service wrote the mission back as BIDDING (`BidService.place`), and
    // the write evicted the feed's cached id lists — so the card in the
    // marketplace now carries the Bidding chip, not Published.
    await page.goto("/missions");
    await page.getByLabel("Filter by location").fill(missionLocation);
    await expect(missionCard(page, missionName)).toContainText("Bidding");
    await expect(missionCard(page, missionName)).not.toContainText("Published");
  });

  test("the pilot edits only the message and keeps the price", async ({ page }) => {
    await signIn(page, pilot);
    await page.goto(`/missions/${missionId}`);

    // "Blank = keep" is advertised by both placeholders, which is what makes
    // leaving the amount empty a deliberate choice rather than an omission.
    await expect(page.getByLabel("Update your bid (USD)")).toHaveAttribute(
      "placeholder",
      `Current: $${bidAmount} (leave blank to keep)`,
    );
    await expect(page.getByLabel("Message (optional)")).toHaveAttribute(
      "placeholder",
      "Leave blank to keep your current message",
    );

    // Amount left untouched; only the note changes.
    await page.getByLabel("Message (optional)").fill(editedMessage);
    await page.getByRole("button", { name: "Update bid" }).click();

    // The toast quotes the price the update was sent with — the old one.
    await expect(toast(page)).toHaveText(`Bid updated — $${bidAmount}`);
    await expect(myBidCard(page)).toContainText(`$${bidAmount}`);
    await expect(page.getByText(`“${editedMessage}”`)).toBeVisible();
    await expect(page.getByText(`“${bidMessage}”`)).toHaveCount(0);

    // Still one bid, not two: `bid_mission_pilot_unique` makes the second
    // place() an update of the same row.
    await expect(bidsTileValue(page)).toHaveText("1");
  });

  test("the bid shows on /my-bids and links back to the mission", async ({ page }) => {
    await signIn(page, pilot);

    // Reached the way a pilot reaches it: the topbar link only pilots get.
    await page.getByRole("link", { name: "My Bids" }).click();
    await expect(page).toHaveURL(/\/my-bids$/);

    const row = page.locator("div").filter({ hasText: missionName }).last();
    await expect(row).toContainText(`“${editedMessage}”`);
    await expect(row).toContainText(`$${bidAmount}`);
    // The status chip renders `BID_STATUS_LABELS.PENDING`, not the raw enum.
    await expect(row).toContainText("Pending");
    await expect(page.getByRole("button", { name: "Withdraw" })).toBeVisible();

    // The row carries `?from=my-bids`, which is the whole point of that param:
    // Back then returns to the bid history instead of the feed.
    await page.getByRole("link", { name: missionName }).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}\\?from=my-bids$`));
    await page.getByRole("button", { name: "← Back to my bids" }).click();
    await expect(page).toHaveURL(/\/my-bids$/);
  });

  test("the designer sees the pilot's bid, with no way to accept it yet", async ({ page }) => {
    await signIn(page, designer); // DESIGNER home is My Missions

    await missionCard(page, missionName).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}$`));

    // The designer gets the list face of the same aside — never the bid form.
    await expect(page.getByText("Bids", { exact: true })).toBeVisible();
    await expect(page.getByText("1 bid", { exact: true })).toBeVisible();
    await expect(page.getByText("Your bid", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Place bid" })).toHaveCount(0);

    // `listForMission` gives the owning designer every bid, resolving the
    // pilot's username server-side (the mapper's `pilotName`).
    await expect(page.getByText(pilot.username)).toBeVisible();
    await expect(page.getByText(`$${bidAmount}`)).toBeVisible();
    await expect(page.getByText(`“${editedMessage}”`)).toBeVisible();

    // Phase 5 ships the award flow; until then the Accept button is absent,
    // not present-and-disabled — see `BidsPanel`'s "deliberately NOT ported".
    await expect(page.getByRole("button", { name: /Accept/i })).toHaveCount(0);
  });

  test("the pilot withdraws the bid and it is gone everywhere", async ({ page }) => {
    await signIn(page, pilot);
    await page.goto("/my-bids");

    await page.getByRole("button", { name: "Withdraw" }).click();
    await expect(toast(page)).toHaveText(`Bid on “${missionName}” withdrawn`);

    // `withdraw` re-loads the whole list, which is now empty.
    await expect(page.getByText("No bids yet")).toBeVisible();
    await expect(page.getByRole("link", { name: missionName })).toHaveCount(0);

    // Gone from the pilot's own panel on the mission too — the form is back to
    // offering a first bid.
    await page.goto(`/missions/${missionId}`);
    await expect(page.getByRole("button", { name: "Place bid" })).toBeVisible();
    await expect(page.getByText("Current bid")).toHaveCount(0);
    await expect(bidsTileValue(page)).toHaveText("0");

    // …and from the designer's list. Same browser context: signing in as the
    // designer replaces the stored token, exactly as it would for a user who
    // switches accounts.
    await signIn(page, designer);
    await page.goto(`/missions/${missionId}`);
    await expect(page.getByText("0 bids", { exact: true })).toBeVisible();
    await expect(page.getByText("No bids have come in yet.")).toBeVisible();
    await expect(page.getByText(pilot.username)).toHaveCount(0);
  });
});
