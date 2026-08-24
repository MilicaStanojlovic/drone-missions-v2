import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mission } from "@/features/missions/mission.types";
import { MissionNotFoundError } from "@/features/missions/server/mission.service";
import type { User } from "@/features/users/user.types";
import type { RatingWrite } from "@/features/ratings/server/rating.queries";
import type { Rating } from "@/features/ratings/rating.types";

/**
 * Vitest suite for `rating.service.ts`.
 *
 * Mirrors every case of `RatingServiceTest` one-for-one, keeping the Java
 * method names as the `it` titles so the two suites can be diffed:
 * `designerRatingResolvesToTheAwardedPilot`, `pilotRatingResolvesToTheDesigner`,
 * `creatingARatingRecordsTheRaterWithTheirDerivedRole`,
 * `aRejectedRatingRecordsNothing`, `someoneWhoTookNoPartCannotRate`,
 * `anUnfinishedMissionCannotBeRated`, `ratingTwiceIsRejected`,
 * `ratingAMissionThatDoesNotExistIsANotFound`,
 * `designerCannotRateWhenNoPilotWasAwarded`,
 * `onlyParticipantsMayReadAMissionsRatings`, `noIdsMeansNoQuery`,
 * `summaryForANullUserIsNone` and `nullIdsAreSkippedRatherThanQueried`.
 *
 * ## Where the five summary cases live
 * The Java suite tests `summariesFor`/`summaryFor` on the *service*; this port
 * put them in `rating.queries.ts` in Phase 2 (that file documents why — they
 * are pure aggregates with no policy above them), so their cases are split by
 * what each one actually asserts:
 *
 *  - the two *value* cases — `summariesAreKeyedByRateeAndSkipUnratedUsers` and
 *    `anUnratedUserSummarisesAsNone` — are already covered in
 *    `rating.queries.test.ts`, against the real `GROUP BY` rather than a stub,
 *    which is strictly stronger than the Mockito original. They are not
 *    repeated here;
 *  - the three *no-query* cases — `noIdsMeansNoQuery`,
 *    `summaryForANullUserIsNone` and `nullIdsAreSkippedRatherThanQueried` —
 *    each assert `verify(ratingRepository, never())`, i.e. that the database is
 *    never touched at all. A live-DB suite structurally cannot show that (and
 *    is skipped outright without a `DATABASE_URL`), so they land here, where
 *    `getDb` is a spy that fails the test if anything reaches for a connection.
 *    The real `summariesFor`/`summaryFor` run — only the row-level functions
 *    are stubbed out of `./rating.queries`.
 *
 * ## Mocking
 * Mirrors the Java test's collaborators: the rating queries and the mission DAO
 * are stubbed, and `audit.ts` is only partially mocked — `record()` (the DB
 * write) is a spy while the real `ratingCreated` factory runs, so a captured
 * entry proves the service audits the exact shape the Java `ArgumentCaptor`
 * asserts on, derived role included. There is no `userRepository` stub to port:
 * the Java service resolves `rater`/`ratee` through
 * `userRepository.getReferenceById` purely to set an FK (its own comment says
 * so), which here is just the id passed to `insertRating`.
 *
 * Nothing about ordering, the joins that carry the two names, or
 * `rating_mission_rater_unique` can be seen from here — those are SQL, and
 * `rating.queries.test.ts` pins them against a real database. What this suite
 * owns is the policy: the guard order, the counterpart resolution, and what is
 * (and is not) written when a rating is refused.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/rating/RatingServiceTest.java
 * - drone-missions-backend/.../business/service/rating/RatingService.java
 * - drone-missions-backend/.../business/service/audit/NewAuditEntry.java (`ratingCreated`)
 */

const queriesMock = {
  insertRating: vi.fn(),
  existsByMissionAndRater: vi.fn(),
  findByMissionId: vi.fn(),
  findByRateeId: vi.fn(),
};
// Partial: the row-level reads and the write are stubbed, while the real
// `summariesFor`/`summaryFor` stay in place for the three no-query cases.
vi.mock("@/features/ratings/server/rating.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/ratings/server/rating.queries")>();
  return {
    ...actual,
    insertRating: (...args: unknown[]) => queriesMock.insertRating(...args),
    existsByMissionAndRater: (...args: unknown[]) => queriesMock.existsByMissionAndRater(...args),
    findByMissionId: (...args: unknown[]) => queriesMock.findByMissionId(...args),
    findByRateeId: (...args: unknown[]) => queriesMock.findByRateeId(...args),
  };
});

const daoMock = {
  findById: vi.fn(),
  findFresh: vi.fn(),
  findOpen: vi.fn(),
  findByUserId: vi.fn(),
  findByAwardedPilotId: vi.fn(),
  invalidateLists: vi.fn(),
  invalidate: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};
vi.mock("@/features/missions/server/mission.cache", () => ({ getMissionDao: () => daoMock }));

/**
 * A stand-in for the connection handle, which nothing in this suite should
 * ever ask for: the service reaches the database only through the stubbed
 * query module, and the three no-query cases below assert exactly that. It
 * throws rather than returning a dummy so a regression that started issuing a
 * query fails loudly here instead of silently opening a real pool on a
 * developer's machine (where `DATABASE_URL` *is* set).
 */
const getDbMock = vi.fn(() => {
  throw new Error("getDb() called: this suite expects no database access at all");
});
vi.mock("@/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/client")>();
  return { ...actual, getDb: () => getDbMock() };
});

const recordMock = vi.fn();
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, record: (...args: unknown[]) => recordMock(...args) };
});

// `vi.mock` calls above are hoisted by Vitest, so these static imports already
// resolve against the mocked modules — including the two real aggregate
// functions re-exported from the partially mocked query module.
import { RATING_SUMMARY_NONE, summariesFor, summaryFor } from "@/features/ratings/server/rating.queries";
import {
  AlreadyRatedError,
  NotMissionParticipantError,
  RatingNotYetAllowedError,
  create,
  forMission,
  receivedBy,
} from "@/features/ratings/server/rating.service";

/** The Java test's constants, unchanged. */
const MISSION_ID = 7;
const DESIGNER_ID = 1;
const PILOT_ID = 2;
const OUTSIDER_ID = 99;

/** The id the stubbed insert assigns, mirroring `givenSaveAssignsId`. */
const SAVED_RATING_ID = 11;

const MISSION_NAME = "Bridge survey";

/** The Java test's `user(id)` helper, with the columns this port has. */
function fakeUser(id: number, role: User["role"]): User {
  return {
    id,
    username: `user${id}`,
    email: `user${id}@example.com`,
    passwordHash: "hash",
    role,
    suspended: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/**
 * The Java test's `missionWith(status)` helper: mission 7, designer 1, awarded
 * pilot 2. `completedMission()` is `fakeMission()` with the default status.
 */
function fakeMission(overrides: Partial<Mission> = {}): Mission {
  // `in`, not `??`: an explicit `designer: null` override (the ownerless
  // mission case) must survive rather than fall back to the default designer.
  const designer: User | null =
    "designer" in overrides ? (overrides.designer ?? null) : fakeUser(DESIGNER_ID, "DESIGNER");
  return {
    id: MISSION_ID,
    name: MISSION_NAME,
    description: null,
    status: "COMPLETED",
    moderation: "VISIBLE",
    userId: designer === null ? null : designer.id,
    awardedPilotId: PILOT_ID,
    startTime: null,
    endTime: null,
    location: "Novi Sad",
    biddingDeadline: null,
    waypoints: null,
    geofence: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
    designer,
  };
}

/** The port of `givenMission(mission)`. */
function givenMission(mission: Mission = fakeMission()): Mission {
  daoMock.findById.mockResolvedValue(mission);
  return mission;
}

/**
 * The port of `givenSaveAssignsId()`: the insert echoes the write back as the
 * saved row, with the identity id the database would have assigned and the two
 * names the joins resolve.
 */
function givenSaveAssignsId(): void {
  queriesMock.insertRating.mockImplementation(async (write: RatingWrite): Promise<Rating> => ({
    id: SAVED_RATING_ID,
    missionId: write.missionId,
    raterId: write.raterId,
    rateeId: write.rateeId,
    score: write.score,
    comment: write.comment,
    createdAt: new Date("2026-04-10T09:00:00Z"),
    mission: { id: write.missionId, name: MISSION_NAME },
    rater: { id: write.raterId, username: `user${write.raterId}` },
  }));
}

/** The single write the service handed the DAO — the Java test's `captureSaved()`. */
function capturedWrite(): RatingWrite {
  expect(queriesMock.insertRating).toHaveBeenCalledTimes(1);
  return queriesMock.insertRating.mock.calls[0][0] as RatingWrite;
}

/** The single audit entry the service recorded — the Java test's `ArgumentCaptor`. */
function capturedEntry() {
  expect(recordMock).toHaveBeenCalledTimes(1);
  return recordMock.mock.calls[0][0];
}

/** A stored rating as the query layer hands it back. */
function fakeRating(overrides: Partial<Rating> = {}): Rating {
  return {
    id: SAVED_RATING_ID,
    missionId: MISSION_ID,
    raterId: DESIGNER_ID,
    rateeId: PILOT_ID,
    score: 5,
    comment: null,
    createdAt: new Date("2026-04-10T09:00:00Z"),
    mission: { id: MISSION_ID, name: MISSION_NAME },
    rater: { id: DESIGNER_ID, username: `user${DESIGNER_ID}` },
    ...overrides,
  };
}

describe("rating.service.ts", () => {
  beforeEach(() => {
    // The default arrangement, restated per case because `clearAllMocks`
    // clears recorded calls but keeps stubbed return values: without this, the
    // one case that arms the already-rated conflict would arm it for every
    // case after it.
    queriesMock.existsByMissionAndRater.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("create — the RatingServiceTest cases", () => {
    it("designerRatingResolvesToTheAwardedPilot", async () => {
      givenMission();
      givenSaveAssignsId();

      await create(MISSION_ID, DESIGNER_ID, 5, "great flying");

      const saved = capturedWrite();
      expect(saved.raterId).toBe(DESIGNER_ID);
      expect(saved.rateeId).toBe(PILOT_ID);
      expect(saved.score).toBe(5);
      expect(saved.comment).toBe("great flying");
      // The caller never names a ratee; it is derived from the mission.
      expect(saved.missionId).toBe(MISSION_ID);
    });

    it("pilotRatingResolvesToTheDesigner", async () => {
      givenMission();
      givenSaveAssignsId();

      await create(MISSION_ID, PILOT_ID, 4, null);

      const saved = capturedWrite();
      expect(saved.raterId).toBe(PILOT_ID);
      expect(saved.rateeId).toBe(DESIGNER_ID);
    });

    it("creatingARatingRecordsTheRaterWithTheirDerivedRole", async () => {
      givenMission();
      givenSaveAssignsId();

      await create(MISSION_ID, DESIGNER_ID, 5, null);

      const entry = capturedEntry();
      expect(entry.actorId).toBe(DESIGNER_ID);
      expect(entry.actorRole).toBe("DESIGNER");
      // The identity id the insert assigned: the entry can only be built from
      // the *saved* row, which is why it is recorded after the write.
      expect(entry.targetId).toBe(SAVED_RATING_ID);
    });

    it("aRejectedRatingRecordsNothing", async () => {
      givenMission(fakeMission({ status: "IN_PROGRESS" }));

      await expect(create(MISSION_ID, PILOT_ID, 5, null)).rejects.toBeInstanceOf(
        RatingNotYetAllowedError,
      );
      expect(recordMock).not.toHaveBeenCalled();
    });

    it("someoneWhoTookNoPartCannotRate", async () => {
      givenMission();

      await expect(create(MISSION_ID, OUTSIDER_ID, 5, null)).rejects.toBeInstanceOf(
        NotMissionParticipantError,
      );
      expect(queriesMock.insertRating).not.toHaveBeenCalled();
    });

    it("anUnfinishedMissionCannotBeRated", async () => {
      givenMission(fakeMission({ status: "IN_PROGRESS" }));

      await expect(create(MISSION_ID, PILOT_ID, 5, null)).rejects.toBeInstanceOf(
        RatingNotYetAllowedError,
      );
      expect(queriesMock.insertRating).not.toHaveBeenCalled();
    });

    it("ratingTwiceIsRejected", async () => {
      givenMission();
      queriesMock.existsByMissionAndRater.mockResolvedValue(true);

      await expect(create(MISSION_ID, PILOT_ID, 5, null)).rejects.toBeInstanceOf(AlreadyRatedError);
      expect(queriesMock.existsByMissionAndRater).toHaveBeenCalledWith(MISSION_ID, PILOT_ID);
      expect(queriesMock.insertRating).not.toHaveBeenCalled();
    });

    it("ratingAMissionThatDoesNotExistIsANotFound", async () => {
      daoMock.findById.mockResolvedValue(undefined);

      await expect(create(MISSION_ID, PILOT_ID, 5, null)).rejects.toBeInstanceOf(
        MissionNotFoundError,
      );
    });

    it("designerCannotRateWhenNoPilotWasAwarded", async () => {
      // A mission completed before anyone was awarded leaves the designer with
      // nobody to rate.
      givenMission(fakeMission({ awardedPilotId: null }));

      await expect(create(MISSION_ID, DESIGNER_ID, 5, null)).rejects.toBeInstanceOf(
        NotMissionParticipantError,
      );
      expect(queriesMock.insertRating).not.toHaveBeenCalled();
    });
  });

  describe("forMission — the RatingServiceTest case", () => {
    it("onlyParticipantsMayReadAMissionsRatings", async () => {
      givenMission();

      await expect(forMission(MISSION_ID, OUTSIDER_ID)).rejects.toBeInstanceOf(
        NotMissionParticipantError,
      );
      expect(queriesMock.findByMissionId).not.toHaveBeenCalled();
    });
  });

  describe("the aggregates — the RatingServiceTest cases that assert no query", () => {
    it("noIdsMeansNoQuery", async () => {
      // `WHERE ratee_id IN ()` is not valid SQL, so the empty input has to
      // short-circuit rather than be handed to the database.
      expect(await summariesFor([])).toEqual(new Map());
      expect(getDbMock).not.toHaveBeenCalled();
    });

    it("summaryForANullUserIsNone", async () => {
      // A mission with no owner (a V4-era legacy row) must not blow up the
      // summary lookup.
      expect(await summaryFor(null)).toEqual(RATING_SUMMARY_NONE);
      expect(await summaryFor(undefined)).toEqual(RATING_SUMMARY_NONE);
      expect(getDbMock).not.toHaveBeenCalled();
    });

    it("nullIdsAreSkippedRatherThanQueried", async () => {
      expect(await summariesFor([null, null])).toEqual(new Map());
      expect(await summariesFor([null, undefined])).toEqual(new Map());
      expect(getDbMock).not.toHaveBeenCalled();
    });
  });

  // --- Beyond the Java suite: what this module owns that a controller test
  // would have covered on the Spring side, plus the port's own divergence ---

  describe("create — the rest of the write path", () => {
    it("reads the mission from the cache, never fresh — rating never writes it", async () => {
      givenMission();
      givenSaveAssignsId();

      await create(MISSION_ID, DESIGNER_ID, 5, null);

      expect(daoMock.findById).toHaveBeenCalledWith(MISSION_ID);
      expect(daoMock.findFresh).not.toHaveBeenCalled();
      // Nothing here hands a mission back to `save()`, which is what makes a
      // cached copy safe.
      expect(daoMock.save).not.toHaveBeenCalled();
    });

    it("returns the saved row, and audits it after the insert rather than before", async () => {
      givenMission();
      givenSaveAssignsId();

      const saved = await create(MISSION_ID, PILOT_ID, 3, "clear brief");

      expect(saved.id).toBe(SAVED_RATING_ID);
      expect(saved.rateeId).toBe(DESIGNER_ID);
      expect(queriesMock.insertRating).toHaveBeenCalledTimes(1);
      // The order is observable through the id: an entry built before the
      // insert could not carry one.
      expect(capturedEntry().targetId).toBe(SAVED_RATING_ID);
    });

    it("derives PILOT for the rater who is not the mission's designer", async () => {
      givenMission();
      givenSaveAssignsId();

      await create(MISSION_ID, PILOT_ID, 4, null);

      const entry = capturedEntry();
      expect(entry.actorId).toBe(PILOT_ID);
      expect(entry.actorRole).toBe("PILOT");
      expect(entry.action).toBe("RATING_CREATED");
      expect(entry.targetType).toBe("RATING");
      expect(entry.details).toBe(`4/5 on "${MISSION_NAME}"`);
    });

    it("stores an absent comment as null — the Angular form omits an empty one", async () => {
      givenMission();
      givenSaveAssignsId();

      await create(MISSION_ID, DESIGNER_ID, 5, undefined);

      expect(capturedWrite().comment).toBeNull();
    });

    it("checks the status before the already-rated conflict, and both before participation", async () => {
      // The source's guard order is observable: a non-participant poking at an
      // unfinished mission learns its status (409) before being told they took
      // no part in it (403). Harmless — mission status is public on the feed —
      // but it is the status code the Angular toast keys off.
      givenMission(fakeMission({ status: "AWARDED" }));

      await expect(create(MISSION_ID, OUTSIDER_ID, 5, null)).rejects.toBeInstanceOf(
        RatingNotYetAllowedError,
      );
      // ...and the already-rated check comes next, still before participation.
      givenMission();
      queriesMock.existsByMissionAndRater.mockResolvedValue(true);

      await expect(create(MISSION_ID, OUTSIDER_ID, 5, null)).rejects.toBeInstanceOf(
        AlreadyRatedError,
      );
    });

    it("names the refused status in the message, as the source does", async () => {
      givenMission(fakeMission({ status: "IN_PROGRESS" }));

      await expect(create(MISSION_ID, PILOT_ID, 5, null)).rejects.toThrow(
        `Mission ${MISSION_ID} is IN_PROGRESS — it can only be rated once completed`,
      );
    });

    it("names the mission in the already-rated and non-participant messages", async () => {
      givenMission();
      queriesMock.existsByMissionAndRater.mockResolvedValue(true);
      await expect(create(MISSION_ID, PILOT_ID, 5, null)).rejects.toThrow(
        `You have already rated mission ${MISSION_ID}`,
      );

      queriesMock.existsByMissionAndRater.mockResolvedValue(false);
      await expect(create(MISSION_ID, OUTSIDER_ID, 5, null)).rejects.toThrow(
        `You did not take part in mission ${MISSION_ID}, so you cannot rate it`,
      );
    });

    it("refuses the awarded pilot of an ownerless mission (KNOWN DIVERGENCE: a 403, not a 500)", async () => {
      // `counterpartOf`'s pilot branch is guarded symmetrically in this port,
      // so a null designer id yields `NotMissionParticipantError`. The source
      // hands the null straight to `getReferenceById(null)` and surfaces an
      // unmapped NPE as a 500. Both refuse the rating; nothing in the app can
      // award a mission that has no designer, so no supported flow gets here.
      givenMission(fakeMission({ designer: null, userId: null }));

      await expect(create(MISSION_ID, PILOT_ID, 5, null)).rejects.toBeInstanceOf(
        NotMissionParticipantError,
      );
      expect(queriesMock.insertRating).not.toHaveBeenCalled();
    });
  });

  describe("forMission — the rest of the read path", () => {
    it("hands both sides' ratings to either participant", async () => {
      const rows = [
        fakeRating({ id: 12, raterId: PILOT_ID, rateeId: DESIGNER_ID }),
        fakeRating({ id: 11 }),
      ];
      givenMission();
      queriesMock.findByMissionId.mockResolvedValue(rows);

      expect(await forMission(MISSION_ID, DESIGNER_ID)).toEqual(rows);
      expect(await forMission(MISSION_ID, PILOT_ID)).toEqual(rows);
      expect(queriesMock.findByMissionId).toHaveBeenCalledWith(MISSION_ID);
    });

    it("reads a missing mission as not found, before the participant gate", async () => {
      daoMock.findById.mockResolvedValue(undefined);

      await expect(forMission(MISSION_ID, DESIGNER_ID)).rejects.toBeInstanceOf(
        MissionNotFoundError,
      );
      expect(queriesMock.findByMissionId).not.toHaveBeenCalled();
    });

    it("lets a participant read the ratings of a mission an admin has hidden", async () => {
      // No visibility filter, matching the source: taking part in a mission is
      // not retracted by hiding it from the marketplace.
      givenMission(fakeMission({ moderation: "HIDDEN" }));
      queriesMock.findByMissionId.mockResolvedValue([]);

      await expect(forMission(MISSION_ID, PILOT_ID)).resolves.toEqual([]);
    });

    it("still gates a mission with no awarded pilot on the designer alone", async () => {
      // Unlike `counterpartOf`, the read gate needs no counterpart: it asks
      // only whether the caller is one of the two ids.
      givenMission(fakeMission({ awardedPilotId: null }));
      queriesMock.findByMissionId.mockResolvedValue([]);

      await expect(forMission(MISSION_ID, DESIGNER_ID)).resolves.toEqual([]);
      await expect(forMission(MISSION_ID, PILOT_ID)).rejects.toBeInstanceOf(
        NotMissionParticipantError,
      );
    });
  });

  describe("receivedBy", () => {
    it("is ungated — a reputation is public, unlike one mission's exchange", async () => {
      const rows = [fakeRating()];
      queriesMock.findByRateeId.mockResolvedValue(rows);

      expect(await receivedBy(PILOT_ID)).toEqual(rows);
      expect(queriesMock.findByRateeId).toHaveBeenCalledWith(PILOT_ID);
      // No mission is loaded and no participant check runs: `receivedBy` spans
      // missions, so there is no single membership record to consult.
      expect(daoMock.findById).not.toHaveBeenCalled();
    });
  });
});
