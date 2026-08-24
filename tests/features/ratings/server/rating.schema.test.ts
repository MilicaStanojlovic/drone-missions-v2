import { describe, expect, it } from "vitest";
import { ratingRequestSchema } from "@/features/ratings/server/rating.schema";

/**
 * Vitest suite for `rating.schema.ts` — DB-less coverage of the two validation
 * rules ported from `RatingRequest`: `@NotNull @Min(1) @Max(5) Short score`
 * and `@Size(max = 500) String comment`.
 *
 * The backend has no unit test for `RatingRequest` (its constraints are only
 * exercised end-to-end through `RatingController`; `RatingServiceTest` starts
 * below validation, with a score already in hand), so these cases pin the
 * annotations directly, one `it` per annotation edge. As in
 * `bid.schema.test.ts`, each rejection asserts the property *path* as well as
 * the failure: `withErrorHandling` (like `GlobalExceptionHandler`) builds its
 * 400 body from path-carrying field errors alone, so a violation reported
 * without a path would vanish from the response the Angular rating form
 * renders.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/dto/rating/RatingRequest.java
 * - drone-missions-frontend/.../components/rating-form/rating-form.component.ts
 */

/** The set of failing property paths, mirroring the bid suite's helper. */
function propertyPaths(value: unknown): string[] {
  const result = ratingRequestSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

/** The messages reported for one property, to pin the Hibernate defaults. */
function messagesFor(value: unknown, path: string): string[] {
  const result = ratingRequestSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues
    .filter((issue) => issue.path.join(".") === path)
    .map((issue) => issue.message);
}

function isValid(value: unknown): boolean {
  return ratingRequestSchema.safeParse(value).success;
}

/** A 501-character comment — one over `@Size(max = 500)`. */
const TOO_LONG = "x".repeat(501);
/** Exactly at the cap, which `@Size(max = 500)` still accepts. */
const AT_CAP = "x".repeat(500);

describe("ratingRequestSchema (ports RatingRequest's constraints)", () => {
  it("accepts a score with a comment", () => {
    expect(isValid({ score: 5, comment: "Flew the whole plan, sent stills the same day." })).toBe(
      true,
    );
  });

  it("accepts a score-only payload, the shape the star picker alone produces", () => {
    // RatingFormComponent builds `{ score }` and only adds `comment` when the
    // textarea has non-blank text.
    expect(isValid({ score: 4 })).toBe(true);
  });

  it("accepts both inclusive bounds, mirroring @Min(1)/@Max(5)", () => {
    expect(isValid({ score: 1 })).toBe(true);
    expect(isValid({ score: 5 })).toBe(true);
  });

  it("accepts every score the star picker can emit", () => {
    for (const score of [1, 2, 3, 4, 5]) {
      expect(isValid({ score })).toBe(true);
    }
  });

  it("requires a score, mirroring @NotNull", () => {
    expect(propertyPaths({ comment: "no stars" })).toEqual(["score"]);
    expect(messagesFor({ comment: "no stars" }, "score")).toEqual(["must not be null"]);
  });

  it("rejects a null score, mirroring @NotNull", () => {
    expect(propertyPaths({ score: null })).toEqual(["score"]);
    expect(messagesFor({ score: null }, "score")).toEqual(["must not be null"]);
  });

  it("rejects 0, one below @Min(1)", () => {
    expect(propertyPaths({ score: 0 })).toEqual(["score"]);
    expect(messagesFor({ score: 0 }, "score")).toEqual(["must be greater than or equal to 1"]);
  });

  it("rejects a negative score, mirroring @Min(1)", () => {
    expect(propertyPaths({ score: -1 })).toEqual(["score"]);
  });

  it("rejects 6, one above @Max(5)", () => {
    expect(propertyPaths({ score: 6 })).toEqual(["score"]);
    expect(messagesFor({ score: 6 }, "score")).toEqual(["must be less than or equal to 5"]);
  });

  it("rejects a non-integer score, since the source field is a Short", () => {
    // DIVERGENCE (documented in rating.schema.ts): Jackson's default
    // ACCEPT_FLOAT_AS_INT would truncate 3.5 into a 3-star rating; this
    // refuses it on the same 400 rather than storing a score nobody picked.
    expect(propertyPaths({ score: 3.5 })).toEqual(["score"]);
    expect(messagesFor({ score: 3.5 }, "score")).toEqual(["must be an integer"]);
    expect(propertyPaths({ score: 4.0001 })).toEqual(["score"]);
  });

  it("rejects a non-numeric score", () => {
    // Same divergence: Jackson would parse the string "3" into a Short.
    expect(propertyPaths({ score: "3" })).toEqual(["score"]);
    expect(propertyPaths({ score: Number.NaN })).toEqual(["score"]);
    expect(propertyPaths({ score: true })).toEqual(["score"]);
  });

  it("accepts an omitted comment, which carries no @NotNull", () => {
    expect(isValid({ score: 3 })).toBe(true);
  });

  it("accepts an explicitly null comment", () => {
    // The column is nullable and the field un-annotated: "no comment" is
    // legal however the client spells it.
    expect(isValid({ score: 3, comment: null })).toBe(true);
  });

  it("accepts an empty comment, since @Size only caps the length", () => {
    expect(isValid({ score: 3, comment: "" })).toBe(true);
  });

  it("accepts a 500-character comment, the inclusive @Size cap", () => {
    expect(isValid({ score: 3, comment: AT_CAP })).toBe(true);
  });

  it("rejects a 501-character comment, mirroring @Size(max = 500)", () => {
    expect(propertyPaths({ score: 3, comment: TOO_LONG })).toEqual(["comment"]);
    expect(messagesFor({ score: 3, comment: TOO_LONG }, "comment")).toEqual([
      "size must be between 0 and 500",
    ]);
  });

  it("measures @Size on the raw string, before the trim", () => {
    // 501 characters of which two are padding: Spring measures the wire value,
    // so this is a 400 there and must stay one here.
    expect(propertyPaths({ score: 3, comment: ` ${"x".repeat(499)} ` })).toEqual(["comment"]);
  });

  it("rejects a non-string comment", () => {
    expect(propertyPaths({ score: 3, comment: 5 })).toEqual(["comment"]);
  });

  it("reports both fields when both are invalid", () => {
    // The 400 body carries every field error at once, as Spring's does.
    expect(propertyPaths({ score: 0, comment: TOO_LONG }).sort()).toEqual(["comment", "score"]);
  });

  it("parses to the score/comment pair the service consumes", () => {
    const parsed = ratingRequestSchema.parse({ score: 5, comment: "Excellent work." });
    expect(parsed).toEqual({ score: 5, comment: "Excellent work." });
  });

  it("trims an accepted comment, as the rating form does before posting", () => {
    const parsed = ratingRequestSchema.parse({ score: 4, comment: "  Solid flight.  " });
    expect(parsed.comment).toBe("Solid flight.");
  });

  it("treats a blank comment as absent, so the row stores NULL rather than ''", () => {
    // RatingFormComponent omits the property entirely when `comment.trim()` is
    // falsy; a client that sends the blank string must land in the same state.
    expect(ratingRequestSchema.parse({ score: 4, comment: "" }).comment).toBeUndefined();
    expect(ratingRequestSchema.parse({ score: 4, comment: "   \n\t " }).comment).toBeUndefined();
    expect(ratingRequestSchema.parse({ score: 4, comment: null }).comment).toBeUndefined();
    expect(ratingRequestSchema.parse({ score: 4 }).comment).toBeUndefined();
  });

  it("ignores unknown properties, as Jackson does for an unmapped field", () => {
    // The record has two components; anything else on the body is not part of
    // the request (Spring's ObjectMapper is not configured to fail on it).
    const parsed = ratingRequestSchema.parse({ score: 5, missionId: 7, id: 3 });
    expect(parsed).toEqual({ score: 5, comment: undefined });
  });
});
