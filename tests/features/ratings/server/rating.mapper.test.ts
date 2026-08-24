import { describe, expect, it } from "vitest";
import { toRatingResponse, toUserRatingsResponse } from "@/features/ratings/server/rating.mapper";
import type { Rating } from "@/features/ratings/rating.types";

/**
 * Vitest suite for `rating.mapper.ts`.
 *
 * `RatingMapper` has no JUnit test of its own — it is a field copy — so these
 * cases pin what its javadoc promises and what the Angular client depends on:
 * the flattened `missionName`/`raterName` come off the joined relations, the
 * relation objects themselves never reach the wire, `rateeId` stays the FK
 * column (the ratee relation is deliberately never loaded), and the nullable
 * columns (`comment`, `missionName`) serialize as present-but-null rather than
 * being dropped. `toUserRatingsResponse` additionally pins that the headline
 * numbers come from the aggregate summary, not from the list's length.
 *
 * Follows `bid.mapper.test.ts`.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/mapper/rating/RatingMapper.java
 * - drone-missions-backend/.../web/dto/rating/RatingResponse.java
 * - drone-missions-backend/.../web/dto/rating/UserRatingsResponse.java
 * - drone-missions-backend/.../web/controller/rating/RatingController.java (`forUser`)
 */

function fakeRating(overrides: Partial<Rating> = {}): Rating {
  return {
    id: 7,
    missionId: 1,
    raterId: 5,
    rateeId: 9,
    score: 4,
    comment: "Smooth flight, clean data",
    createdAt: new Date("2026-04-05T11:30:00Z"),
    mission: { id: 1, name: "Orchard survey" },
    rater: { id: 5, username: "pat" },
    ...overrides,
  };
}

describe("rating.mapper.ts", () => {
  describe("toRatingResponse", () => {
    it("flattens the mission and rater relations into ids and names", () => {
      expect(toRatingResponse(fakeRating())).toEqual({
        id: 7,
        missionId: 1,
        missionName: "Orchard survey",
        raterId: 5,
        raterName: "pat",
        rateeId: 9,
        score: 4,
        comment: "Smooth flight, clean data",
        createdAt: new Date("2026-04-05T11:30:00Z"),
      });
    });

    it("never leaks the relation objects onto the response", () => {
      const response: Record<string, unknown> = { ...toRatingResponse(fakeRating()) };

      expect(response).not.toHaveProperty("mission");
      expect(response).not.toHaveProperty("rater");
      expect(Object.keys(response).sort()).toEqual([
        "comment",
        "createdAt",
        "id",
        "missionId",
        "missionName",
        "rateeId",
        "raterId",
        "raterName",
        "score",
      ]);
    });

    it("carries no updatedAt — a rating is written once and never changed", () => {
      expect(toRatingResponse(fakeRating())).not.toHaveProperty("updatedAt");
    });

    it("keeps a rating without a note as an explicit null comment", () => {
      const response = toRatingResponse(fakeRating({ comment: null }));

      // `comment` is a present key holding null, not an absent one: the source
      // record carries no `@JsonInclude(NON_NULL)`.
      expect("comment" in response).toBe(true);
      expect(response.comment).toBeNull();
    });

    it("passes an unnamed mission through as a null missionName", () => {
      expect(
        toRatingResponse(fakeRating({ mission: { id: 1, name: null } })).missionName,
      ).toBeNull();
    });

    it("reads the mission and rater ids off the relations rather than the FK columns", () => {
      // Same values in practice; this pins that the mapper follows the source's
      // `rating.getMission().getId()` / `rating.getRater().getId()`.
      const response = toRatingResponse(
        fakeRating({ mission: { id: 42, name: "Other" }, rater: { id: 3, username: "ada" } }),
      );

      expect(response.missionId).toBe(42);
      expect(response.raterId).toBe(3);
    });

    it("takes rateeId from the column, since the ratee relation is never loaded", () => {
      expect(toRatingResponse(fakeRating({ rateeId: 11 })).rateeId).toBe(11);
    });

    it("maps every legal score through unchanged", () => {
      for (const score of [1, 2, 3, 4, 5]) {
        expect(toRatingResponse(fakeRating({ score })).score).toBe(score);
      }
    });

    it("passes createdAt through as the instant it was written", () => {
      const createdAt = new Date("2026-01-02T03:04:05.678Z");
      const response = toRatingResponse(fakeRating({ createdAt }));

      expect(response.createdAt).toEqual(createdAt);
      // What the wire actually carries: Jackson renders an `Instant` as
      // ISO-8601, and `JSON.stringify` renders a `Date` the same way.
      expect(JSON.parse(JSON.stringify(response)).createdAt).toBe("2026-01-02T03:04:05.678Z");
    });
  });

  describe("toUserRatingsResponse", () => {
    it("composes the headline numbers with the mapped reviews", () => {
      const ratings = [
        fakeRating({ id: 7, score: 4 }),
        fakeRating({ id: 6, score: 5, comment: null, mission: { id: 2, name: "Roof scan" } }),
      ];

      expect(toUserRatingsResponse({ average: 4.5, count: 2 }, ratings)).toEqual({
        average: 4.5,
        count: 2,
        ratings: [toRatingResponse(ratings[0]), toRatingResponse(ratings[1])],
      });
    });

    it("keeps the ratings in the order the query handed them over", () => {
      const ratings = [fakeRating({ id: 9 }), fakeRating({ id: 4 }), fakeRating({ id: 6 })];

      expect(
        toUserRatingsResponse({ average: 4, count: 3 }, ratings).ratings.map((r) => r.id),
      ).toEqual([9, 4, 6]);
    });

    it("reports an unrated user as the summary's zeroes with an empty list", () => {
      // Mirrors `RatingSummary.NONE` reaching `forUser` for a profile nobody
      // has rated: the payload is still present and well-formed.
      expect(toUserRatingsResponse({ average: 0, count: 0 }, [])).toEqual({
        average: 0,
        count: 0,
        ratings: [],
      });
    });

    it("takes average and count from the summary, not from the list", () => {
      // The two come from different queries in the source (a SQL aggregate and
      // a row read), so the mapper must never recompute one from the other.
      const composed = toUserRatingsResponse({ average: 3.25, count: 8 }, [fakeRating()]);

      expect(composed.average).toBe(3.25);
      expect(composed.count).toBe(8);
      expect(composed.ratings).toHaveLength(1);
    });
  });
});
