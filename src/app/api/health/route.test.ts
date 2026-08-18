import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Vitest suite for `GET /api/health`.
 *
 * No Spring/JUnit source to mirror (this route is new — see the doc comment
 * on `route.ts`), so the spec is the route's own contract: 200 always, with
 * `db` reflecting `not_configured` / `up` / `down` as `DATABASE_URL` and the
 * mocked DB ping dictate.
 *
 * `@/lib/env` and `@/db/client` are mocked so each case can drive
 * `DATABASE_URL` and the `SELECT 1` outcome directly, without a real
 * database — the live-connection variant stays "skipped — no DB configured"
 * per the plan.
 */

const executeMock = vi.fn();

vi.mock("@/db/client", () => ({
  getDb: () => ({ execute: executeMock }),
}));

// A plain mutable object (not destructured by the route), so individual
// tests can flip `env.DATABASE_URL` between cases via the imported reference.
// vi.mock calls are hoisted above these imports by Vitest, so the imports
// below already resolve to the mocked modules.
vi.mock("@/lib/env", () => ({
  env: { DATABASE_URL: undefined as string | undefined },
}));

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { GET } from "./route";

const dummyRequest = new Request("http://localhost/api/health");

describe("GET /api/health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    executeMock.mockReset();
    env.DATABASE_URL = undefined;
  });

  it("returns 200 with db: not_configured when DATABASE_URL is unset", async () => {
    const response = await GET(dummyRequest, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", db: "not_configured" });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("returns 200 with db: up when SELECT 1 succeeds", async () => {
    env.DATABASE_URL = "postgres://user:pass@localhost:5432/drone_missions";
    executeMock.mockResolvedValueOnce([{ "?column?": 1 }]);

    const response = await GET(dummyRequest, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", db: "up" });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("returns 200 with db: down when the ping fails, and logs the failure", async () => {
    env.DATABASE_URL = "postgres://user:pass@localhost:5432/drone_missions";
    const dbError = new Error("connection refused");
    executeMock.mockRejectedValueOnce(dbError);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    const response = await GET(dummyRequest, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", db: "down" });
    expect(errorSpy).toHaveBeenCalledWith({ err: dbError }, "Health check: database ping failed");
  });

  it("never returns a non-200 status for a DB failure (boot-level health only)", async () => {
    env.DATABASE_URL = "postgres://user:pass@localhost:5432/drone_missions";
    executeMock.mockRejectedValueOnce(new Error("timeout"));
    vi.spyOn(logger, "error").mockImplementation(() => logger);

    const response = await GET(dummyRequest, { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
  });
});
