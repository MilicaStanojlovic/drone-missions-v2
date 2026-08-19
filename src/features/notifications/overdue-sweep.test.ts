import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mission, MissionStatus } from "@/features/missions/mission.types";
import type { User } from "@/features/users/user.types";
import type { NewNotification as NewNotificationInput } from "./notification.types";

/**
 * Vitest suite for `overdue-sweep.ts`.
 *
 * There is **no** `OverdueNotificationSchedulerTest` in the source repo — the
 * Spring side ships no JUnit coverage for the scheduler at all — so these
 * cases are written against the semantics read directly off
 * `OverdueNotificationScheduler.notifyOverdueMissions()`, one case per
 * behavior the port has to preserve:
 *
 * - the `findOverdue(ACTIVE_AWARDED, cutoff)` call itself: both statuses, and
 *   a cutoff that is the start of *today* in `Europe/Belgrade` rather than
 *   "now" (`LocalDate.now(zone).atStartOfDay(zone).toInstant()`);
 * - `overdueExists(pilotId, missionId)` as the once-ever guard — `continue`
 *   before both side effects, and before the counter;
 * - `notificationService.create(NewNotification.missionOverdue(...))` then
 *   `userRepository.findById(pilotId).ifPresent(...)`: a pilot whose account
 *   has gone still gets the in-app notification, only the mail is skipped;
 * - the `if (notified > 0)` guard on the single summary `log.info`.
 *
 * Mocking mirrors the scheduler's four injected collaborators: the mission DAO
 * (`getMissionDao()`), the notification service, the user lookup and the mail
 * port are stubbed, in the module-mock style `mission.service.test.ts` and
 * `bid.service.test.ts` already use. (`notification.service.test.ts`, which
 * the phase plan points at, is a live-DB suite — its stubbing style does not
 * exist to copy; this sweep needs no database at all, so it is a pure unit
 * suite and the mocks follow the service tests instead.)
 *
 * `notification.types.ts` is deliberately **not** mocked: the copy the pilot
 * reads comes from the real `NewNotification.missionOverdue` factory, so the
 * assertions below pin the actual title/message rather than a stub's echo.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/notification/OverdueNotificationScheduler.java
 * - drone-missions-backend/.../business/service/notification/NotificationService.java
 */

const daoMock = {
  findById: vi.fn(),
  findFresh: vi.fn(),
  findOpen: vi.fn(),
  findByUserId: vi.fn(),
  findByAwardedPilotId: vi.fn(),
  findOverdue: vi.fn(),
  invalidateLists: vi.fn(),
  invalidate: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};
vi.mock("@/features/missions/mission.cache", () => ({ getMissionDao: () => daoMock }));

const createNotificationMock = vi.fn();
const overdueExistsMock = vi.fn();
vi.mock("./notification.service", () => ({
  create: (...args: unknown[]) => createNotificationMock(...args),
  overdueExists: (...args: unknown[]) => overdueExistsMock(...args),
}));

const findUserByIdOrUndefinedMock = vi.fn();
vi.mock("@/features/users/user.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/users/user.queries")>();
  return {
    ...actual,
    findByIdOrUndefined: (...args: unknown[]) => findUserByIdOrUndefinedMock(...args),
  };
});

const sendMissionOverdueMock = vi.fn();
vi.mock("@/lib/email/email.service", () => ({
  emailService: {
    sendNewBid: vi.fn(),
    sendBidDecision: vi.fn(),
    sendMissionOverdue: (...args: unknown[]) => sendMissionOverdueMock(...args),
    sendMissionCancelled: vi.fn(),
  },
}));

// `vi.mock` calls above are hoisted by Vitest, so these static imports already
// resolve against the mocked modules.
import { logger } from "@/lib/logger";
import { runOverdueSweep } from "./overdue-sweep";

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 5,
    username: "pia",
    email: "pia@example.com",
    passwordHash: "hash",
    role: "PILOT",
    suspended: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * A mission as `findOverdue` hands it back: awarded to a pilot, and with an
 * `endTime` already behind the cutoff. The query is what enforces those two —
 * the sweep re-checks neither — so the fixture just satisfies them.
 */
function fakeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 4,
    name: "Orchard survey",
    description: "Fly the north rows",
    status: "AWARDED" as MissionStatus,
    moderation: "VISIBLE",
    userId: 7,
    awardedPilotId: 5,
    startTime: new Date("2026-05-01T08:00:00Z"),
    endTime: new Date("2026-05-01T10:00:00Z"),
    location: "Novi Sad",
    biddingDeadline: "2026-04-25",
    waypoints: null,
    geofence: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    designer: fakeUser({ id: 7, username: "dana", email: "dana@example.com", role: "DESIGNER" }),
    ...overrides,
  };
}

/** The one argument `createNotification` was called with on call `n`. */
function notificationArg(n = 0): NewNotificationInput {
  return createNotificationMock.mock.calls[n][0] as NewNotificationInput;
}

describe("overdue-sweep.ts", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    daoMock.findOverdue.mockResolvedValue([]);
    overdueExistsMock.mockResolvedValue(false);
    createNotificationMock.mockResolvedValue({ id: 1 });
    findUserByIdOrUndefinedMock.mockResolvedValue(fakeUser());
    sendMissionOverdueMock.mockResolvedValue(undefined);
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe("the candidate query", () => {
    it("asks for AWARDED and IN_PROGRESS missions only", async () => {
      await runOverdueSweep();

      expect(daoMock.findOverdue).toHaveBeenCalledTimes(1);
      // `Set.of(AWARDED, IN_PROGRESS)` in the source. COMPLETED needs no nudge
      // and CANCELLED no longer wants one, so neither may leak in here.
      expect(daoMock.findOverdue.mock.calls[0][0]).toEqual(["AWARDED", "IN_PROGRESS"]);
    });
  });

  describe("a newly-overdue mission", () => {
    it("creates exactly one notification and sends exactly one email", async () => {
      const mission = fakeMission();
      daoMock.findOverdue.mockResolvedValue([mission]);

      await runOverdueSweep();

      expect(overdueExistsMock).toHaveBeenCalledWith(5, 4);
      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      // The real `NewNotification.missionOverdue` copy, not a stub's echo.
      expect(notificationArg()).toEqual({
        userId: 5,
        type: "MISSION_OVERDUE",
        title: "Has your flight ended?",
        message:
          '"Orchard survey" has passed its end date. Mark it finished if the flight is done.',
        mission: { id: 4, name: "Orchard survey" },
      });

      expect(findUserByIdOrUndefinedMock).toHaveBeenCalledWith(5);
      expect(sendMissionOverdueMock).toHaveBeenCalledTimes(1);
      expect(sendMissionOverdueMock).toHaveBeenCalledWith(
        { email: "pia@example.com", username: "pia" },
        { id: 4, name: "Orchard survey", location: "Novi Sad" },
      );
    });

    it("logs one summary line naming how many pilots were notified", async () => {
      daoMock.findOverdue.mockResolvedValue([
        fakeMission({ id: 4, awardedPilotId: 5 }),
        fakeMission({ id: 6, awardedPilotId: 8, status: "IN_PROGRESS" as MissionStatus }),
      ]);

      await runOverdueSweep();

      expect(createNotificationMock).toHaveBeenCalledTimes(2);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        "Overdue sweep: notified 2 pilot(s) of finished-flight checks",
      );
    });
  });

  describe("the once-ever guard", () => {
    it("skips a mission this pilot has already been notified about — no notification, no email", async () => {
      daoMock.findOverdue.mockResolvedValue([fakeMission()]);
      overdueExistsMock.mockResolvedValue(true);

      await runOverdueSweep();

      expect(createNotificationMock).not.toHaveBeenCalled();
      expect(sendMissionOverdueMock).not.toHaveBeenCalled();
      // The source's `continue` lands before `notified++`, so a sweep that
      // found only already-notified missions must stay silent.
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it("skips only the guarded mission, still notifying the others in the batch", async () => {
      daoMock.findOverdue.mockResolvedValue([
        fakeMission({ id: 4, awardedPilotId: 5 }),
        fakeMission({ id: 6, awardedPilotId: 8 }),
      ]);
      overdueExistsMock.mockImplementation(async (_pilotId: number, missionId: number) => {
        return missionId === 4;
      });

      await runOverdueSweep();

      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      expect(notificationArg().mission).toEqual({ id: 6, name: "Orchard survey" });
      expect(infoSpy).toHaveBeenCalledWith(
        "Overdue sweep: notified 1 pilot(s) of finished-flight checks",
      );
    });
  });

  describe("a pilot whose account is gone", () => {
    it("still creates the notification, and sends no email", async () => {
      daoMock.findOverdue.mockResolvedValue([fakeMission()]);
      // The non-throwing lookup, mirroring the source's `.ifPresent`.
      findUserByIdOrUndefinedMock.mockResolvedValue(undefined);

      await runOverdueSweep();

      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      expect(sendMissionOverdueMock).not.toHaveBeenCalled();
      // `notified++` runs either way in the source — the count is of pilots
      // notified in-app, not of mails sent.
      expect(infoSpy).toHaveBeenCalledWith(
        "Overdue sweep: notified 1 pilot(s) of finished-flight checks",
      );
    });

    it("carries on to the next mission rather than aborting the sweep", async () => {
      daoMock.findOverdue.mockResolvedValue([
        fakeMission({ id: 4, awardedPilotId: 5 }),
        fakeMission({ id: 6, awardedPilotId: 8 }),
      ]);
      findUserByIdOrUndefinedMock.mockImplementation(async (id: number) =>
        id === 5 ? undefined : fakeUser({ id: 8, username: "pero", email: "pero@example.com" }),
      );

      await runOverdueSweep();

      expect(createNotificationMock).toHaveBeenCalledTimes(2);
      expect(sendMissionOverdueMock).toHaveBeenCalledTimes(1);
      expect(sendMissionOverdueMock).toHaveBeenCalledWith(
        { email: "pero@example.com", username: "pero" },
        expect.objectContaining({ id: 6 }),
      );
    });
  });

  describe("nothing overdue", () => {
    it("does nothing at all and writes no log line", async () => {
      daoMock.findOverdue.mockResolvedValue([]);

      await expect(runOverdueSweep()).resolves.toBeUndefined();

      expect(overdueExistsMock).not.toHaveBeenCalled();
      expect(createNotificationMock).not.toHaveBeenCalled();
      expect(sendMissionOverdueMock).not.toHaveBeenCalled();
      // A daily job that found nothing must not add a line to the log every
      // day — the source's `if (notified > 0)`.
      expect(infoSpy).not.toHaveBeenCalled();
    });
  });

  describe("idempotence", () => {
    /**
     * A dedupe stub with the memory the real `notification` table has: a
     * created MISSION_OVERDUE row makes the next `overdueExists` for that
     * pilot+mission true, which is exactly what
     * `existsByUser_IdAndMission_IdAndType` does once the row is committed.
     */
    function statefulDedupe() {
      const seen = new Set<string>();
      overdueExistsMock.mockImplementation(async (pilotId: number, missionId: number) =>
        seen.has(`${pilotId}:${missionId}`),
      );
      createNotificationMock.mockImplementation(async (input: NewNotificationInput) => {
        seen.add(`${input.userId}:${input.mission?.id}`);
        return { id: seen.size };
      });
    }

    it("is a no-op on a second run over the same data", async () => {
      statefulDedupe();
      daoMock.findOverdue.mockResolvedValue([fakeMission()]);

      await runOverdueSweep();
      await runOverdueSweep();

      expect(daoMock.findOverdue).toHaveBeenCalledTimes(2);
      // One notification and one email in total, not one per run — the whole
      // point of the guard.
      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      expect(sendMissionOverdueMock).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledTimes(1);
    });

    it("notifies once even when one batch lists the same mission twice", async () => {
      statefulDedupe();
      // Processing is sequential (a `for` loop, as in the source) precisely so
      // the read-then-write guard closes within a single run; a `Promise.all`
      // would let both iterations read `false` and notify twice.
      const mission = fakeMission();
      daoMock.findOverdue.mockResolvedValue([mission, mission]);

      await runOverdueSweep();

      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      expect(sendMissionOverdueMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("the cutoff", () => {
    /** The `endedBefore` argument of the single `findOverdue` call. */
    function capturedCutoff(): Date {
      return daoMock.findOverdue.mock.calls[0][1] as Date;
    }

    it("is the start of today in Europe/Belgrade, not the moment the sweep runs", async () => {
      // 07:30 Belgrade (CEST, UTC+2) on 19 Aug 2026 — the 09:00 job's
      // neighbourhood. `LocalDate.now(zone).atStartOfDay(zone)` is midnight
      // Belgrade, so a flight that ended at 07:00 this morning is given the
      // rest of the day before it counts as overdue.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-19T05:30:00Z"));

      await runOverdueSweep();

      expect(capturedCutoff()).toBeInstanceOf(Date);
      expect(capturedCutoff().toISOString()).toBe("2026-08-18T22:00:00.000Z");
    });

    it("follows the Belgrade calendar date, not the UTC one", async () => {
      // 01:30 Belgrade on 19 Aug — still 18 Aug in UTC. Reading the date off
      // UTC would put the cutoff a whole day early.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-18T23:30:00Z"));

      await runOverdueSweep();

      expect(capturedCutoff().toISOString()).toBe("2026-08-18T22:00:00.000Z");
    });

    it("tracks the zone's offset across winter time and both DST switches", async () => {
      // Each pair is [frozen instant, expected midnight-in-Belgrade]. The two
      // transition days are what the implementation's re-measure step exists
      // for: the offset at the naive guess differs from the offset at the
      // answer, and a single-pass conversion lands an hour out.
      const cases: [string, string][] = [
        // CET (UTC+1), mid-winter.
        ["2026-01-15T09:00:00.000Z", "2026-01-14T23:00:00.000Z"],
        // Spring forward: 29 Mar 2026, 02:00 CET -> 03:00 CEST. The day starts
        // while the zone is still on CET.
        ["2026-03-29T10:00:00.000Z", "2026-03-28T23:00:00.000Z"],
        // Fall back: 25 Oct 2026, 03:00 CEST -> 02:00 CET. The day starts while
        // the zone is still on CEST.
        ["2026-10-25T12:00:00.000Z", "2026-10-24T22:00:00.000Z"],
      ];

      for (const [now, expected] of cases) {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(now));

        await runOverdueSweep();

        expect(capturedCutoff().toISOString(), `cutoff for ${now}`).toBe(expected);
      }
    });
  });

  describe("a mission with no pilot on it", () => {
    it("is skipped rather than notifying nobody", async () => {
      // `findOverdue`'s `awarded_pilot_id IS NOT NULL` predicate makes this
      // unreachable through the real query; the port keeps the guard because
      // the row type cannot express the predicate, and this pins that it
      // skips (the same no-op the source's null `pilotId` would produce)
      // rather than throwing or creating an ownerless notification.
      daoMock.findOverdue.mockResolvedValue([fakeMission({ awardedPilotId: null })]);

      await expect(runOverdueSweep()).resolves.toBeUndefined();

      expect(overdueExistsMock).not.toHaveBeenCalled();
      expect(createNotificationMock).not.toHaveBeenCalled();
      expect(sendMissionOverdueMock).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
    });
  });
});
