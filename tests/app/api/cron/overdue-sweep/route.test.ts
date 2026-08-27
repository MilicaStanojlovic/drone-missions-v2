import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level suite for `GET /api/cron/overdue-sweep` — the HTTP trigger that
 * replaces the in-process node-cron timer on a serverless host.
 *
 * Unlike the `/api/v1/**` route suites, this one needs no database: the sweep
 * itself already has its own coverage
 * (`tests/features/notifications/server/overdue-sweep.test.ts` for the logic,
 * `e2e/overdue.spec.ts` for the end-to-end run), so `runOverdueSweep` is
 * mocked here and what is asserted is only what the route adds — the
 * authorization gate and the response contract.
 *
 * The gate is the whole point of the file. This endpoint notifies and emails
 * every overdue pilot, so "unset secret means closed, not open" is a security
 * property, not a nicety.
 */

const runOverdueSweepMock = vi.fn();
vi.mock("@/features/notifications/server/overdue-sweep", () => ({
  runOverdueSweep: () => runOverdueSweepMock(),
}));

// The route reads `process.env.CRON_SECRET` per request (deliberately not via
// the eagerly parsed `@/lib/env`), so each case can set it directly.
const SECRET = "test-cron-secret-value";
const originalSecret = process.env.CRON_SECRET;

function request(authorization?: string): Request {
  return new Request("http://localhost/api/cron/overdue-sweep", {
    method: "GET",
    headers: authorization === undefined ? {} : { authorization },
  });
}

/** Imported lazily so each test's `CRON_SECRET` is the one in effect. */
async function callRoute(authorization?: string): Promise<Response> {
  const { GET } = await import("@/app/api/cron/overdue-sweep/route");
  return GET(request(authorization), { params: Promise.resolve({}) });
}

describe("GET /api/cron/overdue-sweep", () => {
  beforeEach(() => {
    runOverdueSweepMock.mockReset();
    runOverdueSweepMock.mockResolvedValue(undefined);
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalSecret;
    }
  });

  it("runs the sweep once when the bearer token matches", async () => {
    const response = await callRoute(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(runOverdueSweepMock).toHaveBeenCalledTimes(1);
  });

  it("401s and sweeps nothing when the Authorization header is missing", async () => {
    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(runOverdueSweepMock).not.toHaveBeenCalled();
  });

  it("401s and sweeps nothing when the token is wrong", async () => {
    const response = await callRoute("Bearer not-the-secret-at-all");

    expect(response.status).toBe(401);
    expect(runOverdueSweepMock).not.toHaveBeenCalled();
  });

  it("rejects a correct secret sent without the Bearer scheme", async () => {
    const response = await callRoute(SECRET);

    expect(response.status).toBe(401);
    expect(runOverdueSweepMock).not.toHaveBeenCalled();
  });

  /**
   * The fail-closed case. An unconfigured deployment must not expose a public
   * endpoint that mails every overdue pilot, so a missing secret refuses even
   * a well-formed request rather than treating "no secret" as "no check".
   */
  it("refuses to sweep when CRON_SECRET is unset, even with a bearer token", async () => {
    delete process.env.CRON_SECRET;

    const response = await callRoute("Bearer anything");

    expect(response.status).toBe(401);
    expect(runOverdueSweepMock).not.toHaveBeenCalled();
  });

  it("treats an empty CRON_SECRET as unset", async () => {
    process.env.CRON_SECRET = "";

    const response = await callRoute("Bearer ");

    expect(response.status).toBe(401);
    expect(runOverdueSweepMock).not.toHaveBeenCalled();
  });

  /**
   * The sweep's own failures must surface as a 5xx: a cron platform can only
   * record a run as failed if the response says so, and the sweep is safe to
   * retry (each pilot/mission pair is notified once, ever). This is the one
   * place the route deliberately differs from `scheduler.ts`'s
   * `runOverdueSweepSafely`, which swallows into a log line instead.
   */
  it("answers 500 when the sweep throws", async () => {
    runOverdueSweepMock.mockRejectedValue(new Error("database unreachable"));

    const response = await callRoute(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    expect(runOverdueSweepMock).toHaveBeenCalledTimes(1);
  });
});
