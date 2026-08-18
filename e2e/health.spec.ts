import { expect, test } from "@playwright/test";

/**
 * Playwright happy-path for Phase 0 — Foundation.
 *
 * No Spring/Angular source to mirror (this is greenfield scaffolding, not a
 * port), so the spec is the plan's own contract: the dev server boots with
 * no DB configured, the landing page renders cleanly, and `GET /api/health`
 * reports `status: "ok"` with `db: "not_configured"` — the boot-level
 * health probe added in this phase (see `src/app/api/health/route.ts`).
 *
 * The DB-connected variant (`db: "up"`) is exercised by the route's own
 * Vitest suite (`src/app/api/health/route.test.ts`) against a mocked pool;
 * here it stays "skipped — no DB configured" per the plan, since this repo
 * has no live Supabase/Postgres instance to boot against.
 */

test.describe("Phase 0 foundation happy path", () => {
  test("landing page renders without console or page errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Drone Missions" })).toBeVisible();
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("GET /api/health returns ok with db not_configured", async ({ request }) => {
    const response = await request.get("/api/health");

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", db: "not_configured" });
  });
});
