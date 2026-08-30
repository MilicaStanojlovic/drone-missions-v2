import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Playwright happy-path e2e for Phase 6 — Ratings.
 *
 * Drives the real running app against the Postgres configured
 * in `DATABASE_URL` (see `MIGRATION_PLAN.md` §8) through the whole rating
 * story this phase ships: a mission is taken all the way to COMPLETED, the two
 * people who actually did the work rate each other exactly once, each sees both
 * halves of the exchange, a second attempt is refused, and the two reputations
 * that result show up where the rest of the app reads them — the pilot's on
 * their profile, the designer's on the mission stars.
 *
 * Live-DB only, skipped with a visible reason when `DATABASE_URL` isn't
 * configured — the same `hasDb` convention as `e2e/lifecycle.spec.ts`,
 * `e2e/bids.spec.ts` and the live-DB Vitest suites. `playwright.config.ts`
 * forwards `DATABASE_URL` from `.env.local`/`.env` (or a real CI secret) into
 * `process.env` for this file to read, and resolves `PORT` the same way — this
 * worktree runs on **3001** so it can sit alongside the main checkout, and the
 * config derives `baseURL` from that same value, so nothing here hardcodes a
 * port.
 *
 * Greenfield e2e coverage, not a JUnit/Angular port — there is no single source
 * test to mirror. SOURCE (behaviour reference): the flows ported by this
 * phase's earlier tasks —
 * - `RatingService.create` (COMPLETED-only, once per rater, counterpart derived
 *   from the mission rather than supplied) and `RatingController.rate` /
 *   `forMission` / `forUser`;
 * - `mission-detail.component.ts` (`loadRatings`'s COMPLETED + participant
 *   gate, `myRating` / `ratingOfMe` / `canRate` / `counterpartName`, and the
 *   ratings aside that swaps the form for the two notes);
 * - `rating-form.component.ts` (the disabled-until-scored submit, the optional
 *   comment, "Ratings are final") and `profile.component.ts` (headline average
 *   plus the review list).
 *
 * **What is driven where.** Everything this phase ships is driven through the
 * browser. The lifecycle *up to* the rateable state is fixture: registering,
 * publishing a mission, bidding, awarding and starting are Phases 1–5 and are
 * already covered end-to-end by `e2e/lifecycle.spec.ts`, so repeating them
 * through the UI here would only lengthen the run. They go through the real
 * public API in `beforeAll`, exactly as `e2e/lifecycle.spec.ts` does for its
 * own fixtures — which also keeps this spec runnable against any deployment,
 * with no direct database access of its own.
 *
 * The one lifecycle step kept in the browser is the **completion**, because it
 * is the gate this phase's UI hangs off: the first test reads the mission page
 * while it is still IN_PROGRESS (no rating panel at all, and the API refuses a
 * rating with a 409 that names the status), then clicks "Mark mission finished"
 * and watches the panel appear in place. Asserting the gate from both sides of
 * the same transition is the point — a spec that started from an
 * already-completed mission could not tell "shown after completion" from
 * "always shown".
 *
 * Steps build on each other (complete → pilot rates → designer rates → both
 * read → reputations), so the suite runs serially and shares one mission id
 * between tests; each test signs its user in through the real login form,
 * because every test gets a fresh browser context (and so an empty
 * `localStorage`).
 *
 * The two scores are deliberately different (pilot gives 5, designer gives 4)
 * so the last test can tell the two reputations apart: 4.0 is the pilot's own
 * average on their profile, 5.0 is the designer's aggregate on the mission
 * stars. Equal scores would let a mixed-up assertion pass.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

/** A user this suite registers and drives. */
interface Account {
  username: string;
  email: string;
  password: string;
  role: "DESIGNER" | "PILOT";
}

test.describe("Phase 6 ratings happy path (live DB)", () => {
  test.skip(!hasDb, "DATABASE_URL not configured — see MIGRATION_PLAN.md §8");

  // `playwright.config.ts` sets `fullyParallel: true`, which would otherwise
  // run these same-file tests concurrently.
  test.describe.configure({ mode: "serial" });

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = "password123";
  const designer: Account = {
    username: `rate-designer-${runId}`,
    email: `e2e-rate-${runId}-designer@example.com`,
    password,
    role: "DESIGNER",
  };
  /** The pilot who wins the mission, finishes it, and rates the designer. */
  const pilot: Account = {
    username: `rate-pilot-${runId}`,
    email: `e2e-rate-${runId}-pilot@example.com`,
    password,
    role: "PILOT",
  };

  /**
   * Unique per run: this suite shares its database with every other run, and
   * `/my-jobs`, `/missions/mine` and the review list are all lists, so only a
   * name nothing else can carry makes the assertions below exact.
   */
  const missionName = `Vineyard survey ${runId}`;
  const missionLocation = `Ratingsburg-${runId}`;

  /** Pilot → designer. Rated first, and the higher of the two. */
  const pilotScore = 5;
  const pilotComment = "Brief was precise and the geofence was already sorted — easy job.";
  /** Designer → pilot. Rated second, and deliberately not 5 (see the header). */
  const designerScore = 4;
  const designerComment = "Flew it cleanly and delivered the same day.";

  /** Set by `beforeAll`, read by every test. */
  let missionId = 0;
  /** Shared request context for the fixtures; disposed in `afterAll`. */
  let api: APIRequestContext;

  // ---- fixtures (the real public API — see the file header) ----

  function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  /**
   * `yyyy-MM-dd`, the wire form of the `LocalDate` `biddingDeadline`. Relative
   * to the run rather than hardcoded, because a bid is refused outright once
   * the deadline has gone by (`BidService.place`).
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

  test.beforeAll(async ({ playwright }, testInfo) => {
    if (!hasDb) {
      return;
    }
    api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });

    await registerViaApi(designer);
    await registerViaApi(pilot);
    const designerAuth = await bearerFor(designer);
    const pilotAuth = await bearerFor(pilot);

    // PUBLISHED, not DRAFT: only a published (or already bidding) mission is
    // open for bids. The two waypoints are the minimum a flight path may have
    // (`@Size(min = 2)`), and the window has already opened so the pilot can
    // legitimately be mid-flight when the first test picks the story up.
    const created = await api.post("/api/v1/missions", {
      headers: { Authorization: designerAuth },
      data: {
        name: missionName,
        description: "Row-by-row NDVI pass at 45 m.",
        status: "PUBLISHED",
        startTime: daysFromNow(-2).toISOString(),
        endTime: daysFromNow(3).toISOString(),
        location: missionLocation,
        biddingDeadline: isoDay(daysFromNow(4)),
        waypoints: [
          { lat: 44.8, lng: 20.45, altitude: 45, action: "PHOTO" },
          { lat: 44.81, lng: 20.46, altitude: 45, action: "PHOTO" },
        ],
        geofence: null,
      },
    });
    expect(created.status()).toBe(201);
    missionId = ((await created.json()) as { id: number }).id;
    expect(missionId).toBeGreaterThan(0);

    // 200, not 201: the same endpoint updates an existing bid as often as it
    // creates one, and the source returns `ResponseEntity.ok(...)` for both.
    const placed = await api.post(`/api/v1/bids/mission/${missionId}`, {
      headers: { Authorization: pilotAuth },
      data: { amount: 380, message: "Multispectral rig, two batteries." },
    });
    expect(placed.status()).toBe(200);
    const bidId = ((await placed.json()) as { id: number }).id;

    const accepted = await api.post(`/api/v1/bids/${bidId}/accept`, {
      headers: { Authorization: designerAuth },
    });
    expect(accepted.status()).toBe(200);

    // Left IN_PROGRESS on purpose: the completion itself is the gate the first
    // test drives through the browser (see the file header).
    const started = await api.post(`/api/v1/missions/${missionId}/start`, {
      headers: { Authorization: pilotAuth },
    });
    expect(started.status()).toBe(200);
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  // ---- account helpers (the real login form — see e2e/lifecycle.spec.ts) ----

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

  /** The confirm dialog every lifecycle action opens. */
  function dialog(page: Page): Locator {
    return page.getByRole("alertdialog");
  }

  /** The transient status message `useToast` raises (`role="status"`). */
  function toast(page: Page): Locator {
    return page.getByRole("status");
  }

  /** The rating aside's own heading — absent entirely until `ratingsReadable`. */
  function ratingPanelTitle(page: Page): Locator {
    return page.getByText("Rating", { exact: true });
  }

  /** The rate form's submit, which is also the "may I still rate?" tell. */
  function submitRating(page: Page): Locator {
    return page.getByRole("button", { name: "Submit rating" });
  }

  /**
   * Picks a score in the form's radiogroup. The radios are labelled
   * "{n} out of 5" (`rating-form.tsx`), which the read-only `RatingStars`
   * aria-label ("4.0 out of 5, 1 rating") never collides with under the
   * `radio` role.
   */
  function star(page: Page, score: number): Locator {
    return page.getByRole("radio", { name: `${score} out of 5` });
  }

  /**
   * `RatingStars`' accessible name for an average — the one string that carries
   * both numbers, and so the assertion that a reputation actually surfaced.
   * Mirrors the component's own `ariaLabel` getter.
   */
  function starsLabel(average: number, count: number): string {
    return `${average.toFixed(1)} out of 5, ${count} rating${count === 1 ? "" : "s"}`;
  }

  /**
   * The mission page's "Designed by …" row — the innermost `div` carrying that
   * text, which is exactly the one holding the designer's aggregate
   * `RatingStars` (`.last()` because ancestors sort before descendants in DOM
   * order — the same idiom `e2e/lifecycle.spec.ts` uses for a bid row).
   */
  function designerByline(page: Page): Locator {
    return page
      .locator("div")
      .filter({ hasText: `Designed by ${designer.username}` })
      .last();
  }

  /**
   * The `Authorization` header for whoever is signed in to this page, read from
   * the JWT `auth.client.ts` stores under `dm_token`. Lets a test put a request
   * the UI deliberately no longer offers (a second rating) straight to the API
   * as that same user.
   */
  async function bearerFrom(page: Page): Promise<string> {
    const token = await page.evaluate(() => window.localStorage.getItem("dm_token"));
    expect(token).toBeTruthy();
    return `Bearer ${token}`;
  }

  /** POSTs a rating as the signed-in user and answers the raw response. */
  function rateViaApi(page: Page, authorization: string, score: number) {
    return page.request.post(`/api/v1/ratings/mission/${missionId}`, {
      headers: { Authorization: authorization },
      data: { score },
    });
  }

  test("no one can rate until the mission is completed", async ({ page }) => {
    await signIn(page, pilot); // PILOT home is the feed itself
    await page.goto(`/missions/${missionId}`);
    await expect(page.getByRole("heading", { name: missionName })).toBeVisible();

    // IN_PROGRESS: `loadRatings`' gate is shut, so the whole aside is absent —
    // not merely a disabled form.
    await expect(page.getByText("Your mission is underway")).toBeVisible();
    await expect(ratingPanelTitle(page)).toHaveCount(0);
    await expect(submitRating(page)).toHaveCount(0);

    // And the gate is the server's, not the page's: going straight to the API
    // is refused with the 409 that names where the mission actually is.
    const refused = await rateViaApi(page, await bearerFrom(page), pilotScore);
    expect(refused.status()).toBe(409);
    const refusal = (await refused.json()) as { status: string; message: string };
    expect(refusal.status).toBe("CONFLICT");
    expect(refusal.message).toBe(
      `Mission ${missionId} is IN_PROGRESS — it can only be rated once completed`,
    );

    // The transition this phase hangs off, in the browser.
    await page.getByRole("button", { name: "Mark mission finished" }).click();
    await expect(dialog(page)).toContainText("Mark mission finished?");
    await dialog(page).getByRole("button", { name: "Yes, it's finished" }).click();
    await expect(toast(page)).toHaveText("Mission marked as completed");
    await expect(page.getByText("✓ Mission completed")).toBeVisible();

    // `refresh()` re-read the mission, `ratingsReadable` flipped, and the aside
    // appeared in place — no navigation, no reload.
    await expect(ratingPanelTitle(page)).toBeVisible();
    await expect(page.getByText(`How was ${designer.username}?`)).toBeVisible();
    await expect(page.getByText("Ratings are final and cannot be changed.")).toBeVisible();
    // Nothing has been said in either direction yet.
    await expect(page.getByText(`${designer.username} hasn’t rated you yet.`)).toBeVisible();
  });

  test("the pilot rates the designer and the form gives way to the rating", async ({ page }) => {
    await signIn(page, pilot);
    await page.goto(`/missions/${missionId}`);

    // Ports `RatingFormComponent`'s `disabled: !score` — a rating with no score
    // cannot be sent at all.
    await expect(submitRating(page)).toBeDisabled();
    await star(page, pilotScore).click();
    await expect(star(page, pilotScore)).toHaveAttribute("aria-checked", "true");
    await expect(submitRating(page)).toBeEnabled();

    await page.getByPlaceholder("Add a comment (optional)…").fill(pilotComment);

    // 200, not 201: `RatingController.rate` returns a plain `ResponseEntity.ok`
    // and no `Location`, and the route mirrors it.
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/v1/ratings/mission/${missionId}` &&
        response.request().method() === "POST",
    );
    await submitRating(page).click();
    expect((await saved).status()).toBe(200);

    // `onRated` re-read the ratings, `canRate` went false, and the form was
    // replaced by what was said — a rating is final, so there is nothing left
    // to edit.
    await expect(page.getByText(`You rated ${designer.username}`)).toBeVisible();
    await expect(page.getByText(`“${pilotComment}”`)).toBeVisible();
    await expect(submitRating(page)).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Score out of 5" })).toHaveCount(0);

    // …and the confirmation outlives the form that raised it. `RatingForm` is
    // unmounted by its own success, so a toast it owned would have been torn
    // down with it after a single GET; it raises through `MissionDetail`'s
    // `useToast` instead, the way the source's root-provided `ToastService`
    // outlives `RatingFormComponent`. Asserted after the form is gone because
    // that is the moment the regression would show.
    await expect(toast(page)).toHaveText("Thanks — your rating was saved");
    // The other direction is still empty: rating is not reciprocal.
    await expect(page.getByText(`${designer.username} hasn’t rated you yet.`)).toBeVisible();
  });

  test("the designer reads the pilot's rating and leaves their own", async ({ page }) => {
    await signIn(page, designer); // DESIGNER home is My Missions
    await missionCard(page, missionName).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}$`));

    // The same aside from the other side: what the pilot said is readable, and
    // the designer's own half is still to be written. `counterpartName` for a
    // designer comes off the accepted bid, so this also pins that lookup.
    await expect(page.getByText(`${pilot.username} rated you`)).toBeVisible();
    await expect(page.getByText(`“${pilotComment}”`)).toBeVisible();
    await expect(page.getByText(`How was ${pilot.username}?`)).toBeVisible();

    await star(page, designerScore).click();
    await page.getByPlaceholder("Add a comment (optional)…").fill(designerComment);
    await submitRating(page).click();

    await expect(page.getByText(`You rated ${pilot.username}`)).toBeVisible();
    await expect(page.getByText(`“${designerComment}”`)).toBeVisible();
    // Both directions now, and no way back into the form.
    await expect(page.getByText(`${pilot.username} rated you`)).toBeVisible();
    await expect(submitRating(page)).toHaveCount(0);
  });

  test("both sides see both ratings, and a second rating is refused", async ({ page }) => {
    await signIn(page, pilot);
    await page.goto(`/missions/${missionId}`);

    // The pilot's face of the finished exchange — the designer's rating has
    // arrived since the pilot last looked.
    await expect(page.getByText(`You rated ${designer.username}`)).toBeVisible();
    await expect(page.getByText(`${designer.username} rated you`)).toBeVisible();
    await expect(page.getByText(`“${designerComment}”`)).toBeVisible();
    await expect(page.getByText(`${designer.username} hasn’t rated you yet.`)).toHaveCount(0);
    await expect(submitRating(page)).toHaveCount(0);

    // The UI no longer offers a second rating; the server refuses one anyway.
    // `rating_mission_rater_unique` plus `existsByMissionAndRater` make this a
    // rule, not a race.
    const refused = await rateViaApi(page, await bearerFrom(page), 1);
    expect(refused.status()).toBe(409);
    const refusal = (await refused.json()) as { status: string; message: string };
    expect(refusal.status).toBe("CONFLICT");
    expect(refusal.message).toBe(`You have already rated mission ${missionId}`);

    // And the refusal wrote nothing: still one rating per side, the pilot's
    // still the 5 they gave.
    const both = await page.request.get(`/api/v1/ratings/mission/${missionId}`, {
      headers: { Authorization: await bearerFrom(page) },
    });
    expect(both.status()).toBe(200);
    const ratings = (await both.json()) as { score: number; raterName: string }[];
    expect(ratings).toHaveLength(2);
    expect(ratings.map((rating) => rating.score).sort()).toEqual([designerScore, pilotScore]);
  });

  test("the two reputations surface on the profile and on the mission stars", async ({ page }) => {
    await signIn(page, pilot);

    // The pilot's own profile: the headline average is what the designer gave
    // them (4.0), and the review behind it names its author and its mission.
    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: "My Profile" })).toBeVisible();
    const headlineStars = page.locator('div:has(> h2:text-is("Ratings")) > span');
    await expect(headlineStars).toHaveAttribute("aria-label", starsLabel(designerScore, 1));

    const review = page.locator("li").filter({ hasText: designer.username });
    await expect(review).toContainText(designer.username);
    await expect(review).toContainText(`on ${missionName}`);
    await expect(review).toContainText(designerComment);

    // The designer's aggregate is the other half of the same exchange (5.0),
    // and it reaches the app through the mission mapper rather than the ratings
    // API — so it has to show up wherever a mission names its designer.
    await page.goto("/my-jobs");
    await expect(missionCard(page, missionName)).toContainText("Completed");
    await expect(missionCard(page, missionName)).toContainText(`by ${designer.username}`);
    await expect(
      missionCard(page, missionName).getByLabel(starsLabel(pilotScore, 1)),
    ).toBeVisible();

    await missionCard(page, missionName).click();
    await expect(designerByline(page)).toContainText(`Designed by ${designer.username}`);
    // Scoped to the byline on purpose: the ratings aside below carries a
    // `RatingStars` for the pilot's own 5, whose accessible name is the very
    // same string. Only this one is the designer's *aggregate*.
    await expect(designerByline(page).getByLabel(starsLabel(pilotScore, 1))).toBeVisible();
  });
});
