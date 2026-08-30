import { expect, test, type Page } from "@playwright/test";

/**
 * Playwright happy-path e2e for Phase 2 — Missions core.
 *
 * Drives the real running app against the Postgres configured
 * in `DATABASE_URL` (see `MIGRATION_PLAN.md` §8), through the whole
 * mission lifecycle this phase ships: a designer plans a mission on the
 * Leaflet map (waypoints + flight zone) and publishes it, finds it in the
 * open feed under the location / keyword / date filters, opens its detail,
 * edits it (with an invalid flight plan rejected on the way), and deletes
 * it — while a second, PILOT user sees the same mission in the feed but is
 * offered none of the owner's actions.
 *
 * Live-DB only, skipped with a visible reason when `DATABASE_URL` isn't
 * configured — the same `hasDb` convention as `e2e/auth.spec.ts`,
 * `tests/lib/audit.test.ts` and `tests/app/api/v1/missions/routes.test.ts`.
 * `playwright.config.ts` forwards `DATABASE_URL` from `.env.local`/`.env`
 * (or a real CI secret) into `process.env` for this file to read.
 *
 * Greenfield e2e coverage, not a JUnit/Angular port — there is no single
 * source test to mirror. SOURCE (behaviour reference): the Angular flows
 * ported by this phase's earlier tasks — `mission-form.component`,
 * `mission-list.component`, `mission-detail.component`,
 * `mission-map.component`, `waypoint-dialog.component`,
 * `confirm-dialog.component` — plus `MIGRATION_PLAN.md` §9's "Lifecycle
 * e2e" guidance.
 *
 * Two rules shape the assertions below, both of them the source's:
 * - The feed only carries PUBLISHED/BIDDING + VISIBLE missions from
 *   unsuspended designers, which is why the mission is published rather
 *   than saved as a draft.
 * - Edit/Delete are owner-only (`isOwner` in `mission-detail.component.ts`
 *   = DESIGNER whose id equals `mission.userId`), which is what the pilot
 *   test pins: the affordances are absent, not merely disabled.
 *
 * Steps build on each other (create -> read -> edit -> delete), so the
 * suite runs serially and shares `missionId` between tests; each test signs
 * its user in through the real login form, exactly as `e2e/auth.spec.ts`
 * does, because every test gets a fresh browser context (and so an empty
 * `localStorage`).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/** A user this suite registers and drives. */
interface Account {
  username: string;
  email: string;
  password: string;
  role: "DESIGNER" | "PILOT";
}

/** What the waypoint dialog collects (`WaypointDetails`). */
interface WaypointDetails {
  altitude: number;
  /** The option's *label*, as the `<select>` renders it (`WAYPOINT_ACTION_LABELS`). */
  action: string;
  hoverDurationSeconds?: number;
}

/**
 * Where to click inside the planner's map, as a fraction of its box. Relative
 * rather than absolute so the plan stays inside the canvas whatever size the
 * viewport gives it (the map pane is capped against the viewport height).
 */
interface MapSpot {
  fx: number;
  fy: number;
}

test.describe("Phase 2 missions core happy path (live DB)", () => {
  test.skip(!hasDb, "DATABASE_URL not configured — see MIGRATION_PLAN.md §8");

  // `playwright.config.ts` sets `fullyParallel: true`, which would otherwise
  // run these same-file tests concurrently.
  test.describe.configure({ mode: "serial" });

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const designer: Account = {
    username: `designer-${runId}`,
    email: `e2e-missions-${runId}-designer@example.com`,
    password: "password123",
    role: "DESIGNER",
  };
  const pilot: Account = {
    username: `pilot-${runId}`,
    email: `e2e-missions-${runId}-pilot@example.com`,
    password: "password123",
    role: "PILOT",
  };

  /**
   * Unique per run so the filter assertions below can be exact: this suite
   * shares its database with every other run, and the feed is a shared list.
   */
  const missionName = `Rooftop solar survey ${runId}`;
  const editedName = `Rooftop solar survey ${runId} (revised)`;
  const missionLocation = `Testville-${runId}`;
  const missionKeyword = `thermalscan${runId.replace(/\W/g, "")}`;
  const missionDescription = `Fly the array twice and ${missionKeyword} every panel row.`;
  /** The mission's flight window; the date filter is exercised inside it. */
  const startDate = "2026-09-01";
  const endDate = "2026-09-05";
  const inWindowDate = "2026-09-03";

  /** Set by the create test, read by every test after it. */
  let missionId = 0;

  // ---- account helpers (the real register/login forms — see e2e/auth.spec.ts) ----

  async function register(page: Page, account: Account): Promise<void> {
    await page.goto(`/register?role=${account.role}`);
    await page.getByLabel("Username").fill(account.username);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/login\?registered=1$/);
  }

  /** Signs in and waits for the role home `landingGuard` redirects to. */
  async function signIn(page: Page, account: Account): Promise<void> {
    await page.goto("/login");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(account.role === "DESIGNER" ? /\/missions\/mine$/ : /\/missions$/);
  }

  // ---- page helpers ----

  /** The Leaflet canvas of the planner / detail map (one per page). */
  function map(page: Page) {
    return page.locator(".leaflet-container");
  }

  /** Every waypoint pin currently drawn (the zone's drag handles only exist in "Move / edit"). */
  function waypointPins(page: Page) {
    return page.locator(".leaflet-marker-icon");
  }

  /** The route polyline and the flight zone, as Leaflet renders them (SVG paths). */
  function mapShapes(page: Page) {
    return page.locator("path.leaflet-interactive");
  }

  /** A mission card in the feed / dashboard grid, found by its title. */
  function missionCard(page: Page, name: string) {
    return page.locator('a[href^="/missions/"]').filter({ hasText: name });
  }

  /** Clicks the map at `at` and completes the waypoint dialog it opens. */
  async function addWaypoint(page: Page, at: MapSpot, details: WaypointDetails): Promise<void> {
    const before = await waypointPins(page).count();
    const box = await map(page).boundingBox();
    if (!box) {
      throw new Error("the planner map is not laid out — no bounding box to click inside");
    }
    await map(page).click({ position: { x: box.width * at.fx, y: box.height * at.fy } });
    const dialog = page.getByRole("dialog", { name: "New waypoint" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Altitude (m)").fill(String(details.altitude));
    await dialog.getByLabel("Action").selectOption({ label: details.action });
    if (details.hoverDurationSeconds !== undefined) {
      await dialog.getByLabel("Hover duration (s)").fill(String(details.hoverDurationSeconds));
    }
    await dialog.getByRole("button", { name: "Add waypoint" }).click();
    await expect(dialog).toBeHidden();
    await expect(waypointPins(page)).toHaveCount(before + 1);
  }

  /**
   * Where the three waypoints go. The first placement re-centres the map on
   * itself (`fitToPlan` runs once, then `fittedRef` pins the view), so every
   * spot below is kept well clear of the canvas centre — where that first pin
   * ends up — and of the others, so a later click lands on empty map rather
   * than on an existing marker (which would open the *edit* dialog instead).
   */
  const PLAN: MapSpot[] = [
    { fx: 0.2, fy: 0.25 },
    { fx: 0.8, fy: 0.25 },
    { fx: 0.8, fy: 0.75 },
  ];

  test("a designer plans a mission on the map and publishes it", async ({ page }) => {
    await register(page, designer);
    await signIn(page, designer);

    // The dashboard's own "New Mission" affordance (DESIGNER-only).
    await page.getByRole("link", { name: /New Mission/ }).click();
    await expect(page).toHaveURL(/\/missions\/new$/);

    // ---- the brief ----
    await page.getByLabel("Title").fill(missionName);
    await page.getByLabel("Location").fill(missionLocation);
    await page.getByLabel("Description").fill(missionDescription);
    await page.getByLabel("Start date").fill(startDate);
    await page.getByLabel("End date").fill(endDate);

    // ---- the flight plan ----
    await expect(map(page)).toBeVisible();
    await addWaypoint(page, PLAN[0], { altitude: 60, action: "Take a picture" });
    await addWaypoint(page, PLAN[1], {
      altitude: 80,
      action: "Hover",
      hoverDurationSeconds: 30,
    });
    await addWaypoint(page, PLAN[2], { altitude: 45, action: "Stop recording" });

    // Two waypoints or more draw the ordered route line; the zone is added on
    // top of it, so the map ends up with exactly two shapes.
    await expect(mapShapes(page)).toHaveCount(1);
    await page.getByRole("button", { name: /Circle/ }).click();
    await expect(mapShapes(page)).toHaveCount(2);

    // The publish checklist is satisfied (title, 2+ waypoints, every waypoint
    // complete), so Publish saves and routes to the new mission's detail.
    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page).toHaveURL(/\/missions\/\d+$/);
    await expect(page.getByRole("heading", { name: missionName })).toBeVisible();

    missionId = Number(/\/missions\/(\d+)$/.exec(page.url())?.[1]);
    expect(missionId).toBeGreaterThan(0);
  });

  test("the published mission shows in the open feed and honours its filters", async ({ page }) => {
    await signIn(page, designer);
    await page.goto("/missions");
    await expect(missionCard(page, missionName)).toBeVisible();

    // Location filter: debounced (300 ms), mirrored into the URL, and sent to
    // the API as `?location=` — the backend matches it case-insensitively.
    await page.getByLabel("Filter by location").fill(missionLocation.toUpperCase());
    await expect(page).toHaveURL(new RegExp(`location=${missionLocation.toUpperCase()}`));
    await expect(missionCard(page, missionName)).toBeVisible();

    // A filter that matches nothing empties the feed (source copy).
    await page.getByLabel("Filter by location").fill(`nowhere-${runId}`);
    await expect(page.getByText("No missions match your filters")).toBeVisible();
    await expect(missionCard(page, missionName)).toHaveCount(0);

    // Keyword: name OR description. This one only appears in the description.
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByPlaceholder(/Search name or description/).fill(missionKeyword);
    await expect(missionCard(page, missionName)).toBeVisible();

    // Date: a day inside the mission's flight window keeps it in the feed.
    await page.getByLabel("Flyable on date").fill(inWindowDate);
    await expect(missionCard(page, missionName)).toBeVisible();
  });

  test("the owner's detail page renders the flight plan and its owner actions", async ({
    page,
  }) => {
    await signIn(page, designer);

    // Reached the way a designer reaches it: from the dashboard card.
    await missionCard(page, missionName).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}$`));

    await expect(page.getByRole("heading", { name: missionName })).toBeVisible();
    await expect(page.getByText(missionLocation)).toBeVisible();
    await expect(page.getByText(missionDescription)).toBeVisible();
    // "Designed by <strong>{username}</strong>" — the mapper's `designerName`
    // is the account's username, so the byline names the caller themselves.
    await expect(page.getByText("Designed by").locator("strong")).toHaveText(designer.username);

    // The plan survived the round trip: 3 pins, plus the route line and the
    // circular flight zone re-rendered read-only.
    await expect(waypointPins(page)).toHaveCount(3);
    await expect(mapShapes(page)).toHaveCount(2);

    await expect(page.getByRole("link", { name: "Edit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  test("the editor rejects an invalid flight plan, then saves a valid edit", async ({ page }) => {
    await signIn(page, designer);
    await page.goto(`/missions/${missionId}/edit`);

    // Prefilled from the mission (the edit flow's `loadMission`).
    await expect(page.getByLabel("Title")).toHaveValue(missionName);
    await expect(page.getByLabel("Location")).toHaveValue(missionLocation);
    await expect(waypointPins(page)).toHaveCount(3);

    // ---- invalid: HOVER without a duration ----
    // Clicking an existing pin opens the dialog on that waypoint; switching it
    // to HOVER leaves the duration empty, which the dialog refuses to save
    // (`WaypointActionValidator`'s rule, mirrored client-side).
    await waypointPins(page).first().click();
    const dialog = page.getByRole("dialog", { name: "Edit waypoint" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Action").selectOption({ label: "Hover" });
    await dialog.getByLabel("Hover duration (s)").fill("");
    await dialog.getByRole("button", { name: "Save waypoint" }).click();
    await expect(dialog.getByText("Hover duration is required.")).toBeVisible();
    await expect(dialog).toBeVisible(); // still open — nothing was saved
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    // ---- invalid: a single-waypoint flight path ----
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(waypointPins(page)).toHaveCount(0);
    await addWaypoint(page, PLAN[0], { altitude: 50, action: "Take a picture" });

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toContainText(/at least 2 waypoints/);
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/edit$`)); // no save happened

    // Undo the lone waypoint, then the Clear that preceded it.
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(waypointPins(page)).toHaveCount(3);

    // ---- valid: rename and save ----
    await page.getByLabel("Title").fill(editedName);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}$`));
    await expect(page.getByRole("heading", { name: editedName })).toBeVisible();
  });

  test("the API rejects an invalid flight plan and returns the edited mission", async ({
    request,
  }) => {
    // The JWT arrives in the `Authorization` response header (see the login route).
    const login = await request.post("/api/v1/auth/login", {
      data: { email: designer.email, password: designer.password },
    });
    expect(login.status()).toBe(200);
    const authorization = login.headers()["authorization"];
    expect(authorization).toBeTruthy();
    const headers = { Authorization: authorization };

    const flightPlan = {
      name: `Rejected ${runId}`,
      description: "Should never be stored.",
      status: "PUBLISHED",
      startTime: `${startDate}T00:00:00.000Z`,
      endTime: `${endDate}T00:00:00.000Z`,
      location: missionLocation,
      geofence: null,
    };

    // A single dangling point is not a flight path (`@Size(min = 2)`).
    const onePoint = await request.post("/api/v1/missions", {
      headers,
      data: {
        ...flightPlan,
        waypoints: [{ lat: 44.8, lng: 20.45, altitude: 60, action: "PHOTO" }],
      },
    });
    expect(onePoint.status()).toBe(400);
    expect((await onePoint.json()).data).toMatchObject({
      waypoints: "a flight path needs at least 2 waypoints",
    });

    // HOVER without a duration (`WaypointActionValidator`), reported on the
    // offending waypoint's own field path.
    const hoverWithoutDuration = await request.post("/api/v1/missions", {
      headers,
      data: {
        ...flightPlan,
        waypoints: [
          { lat: 44.8, lng: 20.45, altitude: 60, action: "PHOTO" },
          { lat: 44.81, lng: 20.46, altitude: 60, action: "HOVER" },
        ],
      },
    });
    expect(hoverWithoutDuration.status()).toBe(400);
    expect((await hoverWithoutDuration.json()).data).toMatchObject({
      "waypoints[1].hoverDurationSeconds": "must be greater than 0 for a HOVER waypoint",
    });

    // The mission the UI built and edited, as the API returns it.
    const saved = await request.get(`/api/v1/missions/${missionId}`, { headers });
    expect(saved.status()).toBe(200);
    const mission = await saved.json();
    expect(mission).toMatchObject({
      id: missionId,
      name: editedName,
      description: missionDescription,
      location: missionLocation,
      status: "PUBLISHED",
      moderation: "VISIBLE",
      designerName: designer.username,
      designerEmail: designer.email,
      designerSuspended: false,
    });
    expect(mission.waypoints).toHaveLength(3);
    expect(mission.geofence.type).toBe("CIRCLE");
  });

  test("a pilot sees the mission in the feed but is offered no owner actions", async ({ page }) => {
    await register(page, pilot);
    await signIn(page, pilot); // PILOT home is the feed itself

    // Wait for the filtered load to land before clicking, so the card can't be
    // swapped out from under the click by the reload the filter triggers.
    await page.getByLabel("Filter by location").fill(missionLocation);
    await expect(page).toHaveURL(new RegExp(`location=${missionLocation}`));
    await expect(missionCard(page, editedName)).toBeVisible();

    // The card carries the feed's filters into the detail URL, so Back can
    // restore the marketplace the pilot left.
    await missionCard(page, editedName).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}\\?location=`));

    await expect(page.getByRole("heading", { name: editedName })).toBeVisible();
    await expect(waypointPins(page)).toHaveCount(3);

    // `isOwner` is false for a pilot, so the two owner controls are absent —
    // not merely disabled — and Back returns to the feed, not to My Missions.
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "← Back to feed" })).toBeVisible();
  });

  test("the owner deletes the mission and it disappears from both lists", async ({ page }) => {
    await signIn(page, designer);

    await missionCard(page, editedName).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}$`));

    await page.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete mission?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete mission" }).click();

    await expect(page).toHaveURL(/\/missions\/mine$/);
    await expect(missionCard(page, editedName)).toHaveCount(0);

    // Gone from the open feed too — the list cache is invalidated on delete.
    await page.goto("/missions");
    await page.getByLabel("Filter by location").fill(missionLocation);
    await expect(page.getByText("No missions match your filters")).toBeVisible();
  });
});
