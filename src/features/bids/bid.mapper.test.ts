import { describe, expect, it } from "vitest";
import { toBidResponse } from "./bid.mapper";
import type { Bid } from "./bid.types";

/**
 * Vitest suite for `bid.mapper.ts`.
 *
 * `BidMapper` has no JUnit test of its own — it is a field copy — so these
 * cases pin what its javadoc promises and what the Angular client depends on:
 * the flattened `missionName`/`pilotName` come off the joined relations, the
 * relation objects themselves never reach the wire, and the nullable columns
 * (`message`, `missionName`) serialize as present-but-null rather than being
 * dropped.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/mapper/bid/BidMapper.java
 * - drone-missions-backend/.../web/dto/bid/BidResponse.java
 */

function fakeBid(overrides: Partial<Bid> = {}): Bid {
  return {
    id: 3,
    missionId: 1,
    pilotId: 5,
    amount: 250.5,
    message: "Can fly Tuesday",
    status: "PENDING",
    createdAt: new Date("2026-04-02T09:00:00Z"),
    updatedAt: new Date("2026-04-03T09:00:00Z"),
    mission: { id: 1, name: "Orchard survey" },
    pilot: { id: 5, username: "pat" },
    ...overrides,
  };
}

describe("bid.mapper.ts", () => {
  it("flattens the mission and pilot relations into ids and names", () => {
    expect(toBidResponse(fakeBid())).toEqual({
      id: 3,
      missionId: 1,
      missionName: "Orchard survey",
      pilotId: 5,
      pilotName: "pat",
      amount: 250.5,
      message: "Can fly Tuesday",
      status: "PENDING",
      createdAt: new Date("2026-04-02T09:00:00Z"),
      updatedAt: new Date("2026-04-03T09:00:00Z"),
    });
  });

  it("never leaks the relation objects onto the response", () => {
    const response: Record<string, unknown> = { ...toBidResponse(fakeBid()) };

    expect(response).not.toHaveProperty("mission");
    expect(response).not.toHaveProperty("pilot");
    expect(Object.keys(response).sort()).toEqual([
      "amount",
      "createdAt",
      "id",
      "message",
      "missionId",
      "missionName",
      "pilotId",
      "pilotName",
      "status",
      "updatedAt",
    ]);
  });

  it("keeps a bid without a note as an explicit null message", () => {
    const response = toBidResponse(fakeBid({ message: null }));

    // `message` is a present key holding null, not an absent one: the source
    // record carries no `@JsonInclude(NON_NULL)`.
    expect("message" in response).toBe(true);
    expect(response.message).toBeNull();
  });

  it("passes an unnamed mission through as a null missionName", () => {
    expect(toBidResponse(fakeBid({ mission: { id: 1, name: null } })).missionName).toBeNull();
  });

  it("carries the amount as a number, already narrowed by the query layer", () => {
    const response = toBidResponse(fakeBid({ amount: 1500 }));

    expect(response.amount).toBe(1500);
    expect(typeof response.amount).toBe("number");
  });

  it("reads the ids off the relations rather than the FK columns", () => {
    // Same values in practice; this pins that the mapper follows the source's
    // `bid.getMission().getId()` / `bid.getPilot().getId()`.
    const response = toBidResponse(
      fakeBid({ mission: { id: 42, name: "Other" }, pilot: { id: 9, username: "ada" } }),
    );

    expect(response.missionId).toBe(42);
    expect(response.pilotId).toBe(9);
  });

  it("maps every bid status through unchanged", () => {
    for (const status of ["PENDING", "ACCEPTED", "REJECTED"] as const) {
      expect(toBidResponse(fakeBid({ status })).status).toBe(status);
    }
  });
});
