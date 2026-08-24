import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTasks, validate } from "node-cron";

/**
 * Vitest suite for `src/lib/scheduler.ts`.
 *
 * There is nothing to mirror on the Spring side: `@Scheduled` needs no test
 * because the framework owns the registration, and the source ships no test
 * for `OverdueNotificationScheduler` at all. What this file covers is exactly
 * the part the port had to write by hand and Spring gave away for free —
 * translating the cron string, pinning the zone, registering once, and keeping
 * a failed run from killing the process.
 *
 * `node-cron` itself is **not** mocked. The whole point of the module is the
 * hand-off to that library, so a stub would assert the port against a
 * paraphrase of the library's contract instead of the library. The tasks
 * created here are unref'd and destroyed in `afterEach`, so nothing survives
 * the file.
 *
 * The sweep, on the other hand, is mocked: it reaches the database and the
 * mail port, and this file is about *when* it is called, never what it does.
 */

const runOverdueSweepMock = vi.fn();
vi.mock("@/features/notifications/overdue-sweep", () => ({
  runOverdueSweep: () => runOverdueSweepMock(),
}));

// Hoisted `vi.mock` above, so this resolves against the mocked sweep.
import { logger } from "@/lib/logger";
import { OVERDUE_SWEEP_CRON, OVERDUE_SWEEP_ZONE, startScheduler, stopScheduler } from "@/lib/scheduler";

/** The wall clock `zone` shows at `instant`, as `"YYYY-MM-DD HH:mm"`. */
function wallClockIn(zone: string, instant: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: zone,
    hourCycle: "h23",
    dateStyle: "short",
    timeStyle: "short",
  }).format(instant);
}

describe("scheduler.ts", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runOverdueSweepMock.mockResolvedValue(undefined);
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
  });

  afterEach(() => {
    // Before `restoreAllMocks`, so the teardown's own logging is still muted.
    stopScheduler();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe("the schedule", () => {
    it("is a cron expression node-cron accepts", () => {
      expect(validate(OVERDUE_SWEEP_CRON)).toBe(true);
    });

    it("is the source's daily 09:00 Europe/Belgrade", () => {
      expect(OVERDUE_SWEEP_ZONE).toBe("Europe/Belgrade");

      const task = startScheduler();
      const next = task.getNextRun();

      // The translation of `@Scheduled(cron = "0 0 9 * * *", zone =
      // "Europe/Belgrade")` is only correct if the resolved instant reads
      // 09:00 *in Belgrade* — an instant that happens to be 09:00 UTC would
      // be an hour or two off, seasonally, which is the exact bug the zone
      // option exists to prevent.
      expect(next).not.toBeNull();
      expect(wallClockIn("Europe/Belgrade", next!)).toMatch(/ 09:00$/);
    });

    it("fires daily, not hourly — the next two runs are 24h apart", () => {
      // The source's Javadoc says "hourly sweep" while its cron says 09:00
      // daily; the cron is the truth, and this pins the side that was ported.
      const [first, second] = startScheduler().getNextRuns(2);

      expect(second.getTime() - first.getTime()).toBe(24 * 60 * 60_000);
    });
  });

  describe("registration", () => {
    it("registers the sweep exactly once, even when started twice", () => {
      const before = getTasks().size;

      const first = startScheduler();
      const second = startScheduler();

      // Same task object back, and only one entry added to node-cron's
      // registry: a hot reload calling `register()` again must not leave a
      // second 09:00 timer behind.
      expect(second).toBe(first);
      expect(getTasks().size).toBe(before + 1);
    });

    it("logs the registration once", () => {
      startScheduler();
      startScheduler();

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        { cron: OVERDUE_SWEEP_CRON, timezone: OVERDUE_SWEEP_ZONE },
        "Scheduler started: overdue sweep registered",
      );
    });

    it("does not run the sweep at registration time", () => {
      startScheduler();

      expect(runOverdueSweepMock).not.toHaveBeenCalled();
    });
  });

  describe("the scheduled callback", () => {
    it("runs one sweep", async () => {
      await startScheduler().execute();

      expect(runOverdueSweepMock).toHaveBeenCalledTimes(1);
    });

    it("swallows a failing sweep and logs it", async () => {
      const boom = new Error("database unreachable");
      runOverdueSweepMock.mockRejectedValue(boom);

      // Resolves rather than rejects: an unhandled rejection out of an
      // unattended timer would take the whole server down, where Spring's
      // executor would merely have logged it.
      await expect(startScheduler().execute()).resolves.not.toThrow();

      expect(errorSpy).toHaveBeenCalledWith({ err: boom }, "Overdue sweep failed");
    });

    it("keeps the task alive for the next run after a failure", async () => {
      runOverdueSweepMock.mockRejectedValueOnce(new Error("transient"));
      const task = startScheduler();

      await task.execute();
      await task.execute();

      expect(runOverdueSweepMock).toHaveBeenCalledTimes(2);
      expect(task.getNextRun()).not.toBeNull();
    });
  });

  describe("stopScheduler", () => {
    it("tears the task down and lets a later start register a fresh one", () => {
      const before = getTasks().size;
      const first = startScheduler();

      stopScheduler();
      expect(getTasks().size).toBe(before);

      const second = startScheduler();
      expect(second).not.toBe(first);
      expect(getTasks().size).toBe(before + 1);
    });

    it("is a no-op when nothing was started", () => {
      const before = getTasks().size;

      expect(() => stopScheduler()).not.toThrow();
      expect(() => stopScheduler()).not.toThrow();
      expect(getTasks().size).toBe(before);
    });
  });
});
