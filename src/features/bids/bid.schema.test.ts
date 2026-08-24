import { describe, expect, it } from "vitest";
import { bidRequestSchema } from "@/features/bids/bid.schema";

/**
 * Vitest suite for `bid.schema.ts` — DB-less coverage of the two validation
 * rules ported from `BidRequest`: `@NotNull @Positive BigDecimal amount` and
 * `@Size(max = 500) String message`.
 *
 * The backend has no unit test for `BidRequest` (its constraints are only
 * exercised end-to-end through `BidController`), so these cases pin the
 * annotations directly, one `it` per annotation edge. As in
 * `mission.schema.test.ts`, each rejection asserts the property *path* as
 * well as the failure: `withErrorHandling` (like `GlobalExceptionHandler`)
 * builds its 400 body from path-carrying field errors alone, so a violation
 * reported without a path would vanish from the response the Angular bid form
 * renders.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/dto/bid/BidRequest.java
 */

/** The set of failing property paths, mirroring the mission suite's helper. */
function propertyPaths(value: unknown): string[] {
  const result = bidRequestSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

/** The messages reported for one property, to pin the Hibernate defaults. */
function messagesFor(value: unknown, path: string): string[] {
  const result = bidRequestSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues
    .filter((issue) => issue.path.join(".") === path)
    .map((issue) => issue.message);
}

function isValid(value: unknown): boolean {
  return bidRequestSchema.safeParse(value).success;
}

/** A 501-character note — one over `@Size(max = 500)`. */
const TOO_LONG = "x".repeat(501);
/** Exactly at the cap, which `@Size(max = 500)` still accepts. */
const AT_CAP = "x".repeat(500);

describe("bidRequestSchema (ports BidRequest's constraints)", () => {
  it("accepts an amount with a message", () => {
    expect(isValid({ amount: 1250, message: "Ready to fly this weekend." })).toBe(true);
  });

  it("accepts a decimal amount, since the source field is a BigDecimal", () => {
    // numeric(12, 2) / BigDecimal — prices carry cents; this must not be an int rule.
    expect(isValid({ amount: 1250.5 })).toBe(true);
    expect(isValid({ amount: 0.01 })).toBe(true);
  });

  it("accepts an omitted message, which carries no @NotNull", () => {
    expect(isValid({ amount: 1250 })).toBe(true);
  });

  it("accepts an explicitly null message", () => {
    // The column is nullable and the field un-annotated: "no note" is legal
    // however the client spells it.
    expect(isValid({ amount: 1250, message: null })).toBe(true);
  });

  it("accepts an empty message, since @Size only caps the length", () => {
    expect(isValid({ amount: 1250, message: "" })).toBe(true);
  });

  it("requires an amount, mirroring @NotNull", () => {
    expect(propertyPaths({ message: "no price" })).toEqual(["amount"]);
    expect(messagesFor({ message: "no price" }, "amount")).toEqual(["must not be null"]);
  });

  it("rejects a null amount, mirroring @NotNull", () => {
    expect(propertyPaths({ amount: null })).toEqual(["amount"]);
  });

  it("rejects a zero amount, mirroring @Positive's strict bound", () => {
    expect(propertyPaths({ amount: 0 })).toEqual(["amount"]);
    expect(messagesFor({ amount: 0 }, "amount")).toEqual(["must be greater than 0"]);
  });

  it("rejects a negative amount, mirroring @Positive", () => {
    expect(propertyPaths({ amount: -1 })).toEqual(["amount"]);
    expect(propertyPaths({ amount: -0.01 })).toEqual(["amount"]);
  });

  it("rejects a non-numeric amount", () => {
    // DIVERGENCE (documented in bid.schema.ts): Jackson would coerce the
    // string "1250" into a BigDecimal; this rejects it on the same 400.
    expect(propertyPaths({ amount: "1250" })).toEqual(["amount"]);
    expect(propertyPaths({ amount: Number.NaN })).toEqual(["amount"]);
  });

  it("accepts a 500-character message, the inclusive @Size cap", () => {
    expect(isValid({ amount: 1250, message: AT_CAP })).toBe(true);
  });

  it("rejects a 501-character message, mirroring @Size(max = 500)", () => {
    expect(propertyPaths({ amount: 1250, message: TOO_LONG })).toEqual(["message"]);
    expect(messagesFor({ amount: 1250, message: TOO_LONG }, "message")).toEqual([
      "size must be between 0 and 500",
    ]);
  });

  it("reports both fields when both are invalid", () => {
    // The 400 body carries every field error at once, as Spring's does.
    expect(propertyPaths({ amount: 0, message: TOO_LONG }).sort()).toEqual(["amount", "message"]);
  });

  it("parses to the amount/message pair the service consumes", () => {
    const parsed = bidRequestSchema.parse({ amount: 1250.5, message: "Ready." });
    expect(parsed).toEqual({ amount: 1250.5, message: "Ready." });
  });
});
