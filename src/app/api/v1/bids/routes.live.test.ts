import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditLog, bid, mission, notification, users } from "@/db/schema";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { UserRole } from "@/db/schema";
import { POST as registerRoute } from "../auth/register/route";
import { POST as createMissionRoute } from "../missions/route";
import { GET as missionDetailRoute } from "../missions/[id]/route";
import { GET as listRoute, POST as placeRoute } from "./mission/[missionId]/route";
import { GET as myBidsRoute } from "./my/route";
import { DELETE as withdrawRoute } from "./[id]/route";
import { POST as acceptRoute } from "./[id]/accept/route";

/**
 * Route-level **integration** suite for the bid endpoints: the real handlers
 * over the real `BidService`, the real caching mission DAO, the real audit,
 * notification and email services, and a real Postgres, with nothing mocked.
 *
 * This is the live-DB counterpart of `routes.test.ts`, which mocks
 * `BidService` and therefore proves only what the web layer contributes (the
 * role guards, the validation, the status codes). Every behaviour below lives
 * *under* that mock boundary and cannot be proven there:
 *
 * - the first bid on a PUBLISHED mission writing the mission back as BIDDING
 *   — the one place `place()` mutates something other than a bid, and the
 *   reason it loads through `findFresh` rather than the cached `findById`;
 * - the `bid_mission_pilot_unique` upsert as the endpoint sees it: a second
 *   POST from the same pilot updating the row instead of adding one, and
 *   leaving an audit trail that says "(updated)";
 * - hidden missions / suspended designers surfacing as a 404 off *real* rows
 *   rather than a stubbed error, which is what makes bid ids unprobeable;
 * - the deadline comparison against a real `date` column (`LocalDate` parity:
 *   the deadline day itself is still open);
 * - the owner-vs-pilot list split, which is a per-mission fact the service
 *   derives from `mission.userId`, not an endpoint property;
 * - withdraw deleting the row and leaving only its audit entry behind;
 * - the accept cascade as one committed transaction: winner ACCEPTED, every
 *   other bid REJECTED, mission AWARDED with its `awarded_pilot_id`, and the
 *   post-commit cache eviction that makes the award visible to the very next
 *   read of the mission — none of which the endpoint's own response shows,
 *   since it returns only the winning bid;
 * - the best-effort new-bid email actually running end to end under
 *   `MAIL_ENABLED=false` — rendering the template and logging instead of
 *   sending, without breaking the bid.
 *
 * It lives in a separate file rather than in `routes.test.ts` because that
 * file's `vi.mock` of the bid service is module-scoped: a live-DB block inside
 * it would still be talking to the mocks. This is the same split
 * `src/app/api/v1/missions/routes.live.test.ts` makes.
 *
 * Skipped, with a visible reason, when `DATABASE_URL` isn't configured —
 * `vitest.config.ts` forwards the variable from `.env.local`/`.env`.
 *
 * The backend has no `@SpringBootTest` counterpart (its bid tests are the
 * Mockito `BidServiceTest`, mirrored in `bid.service.test.ts`), so each case
 * names the `BidService` rule it pins instead of mirroring a Java test.
 *
 * SOURCE (the behaviour under test, not a test to mirror):
 * - drone-missions-backend/.../web/controller/bid/BidController.java
 * - drone-missions-backend/.../business/service/bid/BidService.java
 * - drone-missions-backend/.../business/service/mail/EmailService.java (`sendNewBid`)
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)("bid routes (live DB)", () => {
  /** Unique per run, so reruns against the same database never collide. */
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`.toLowerCase();
  let emailCounter = 0;

  function uniqueEmail(label: string): string {
    return `bid-route-${runId}-${(emailCounter += 1)}-${label}@example.com`;
  }

  const listContext = { params: Promise.resolve({}) };
  const insertedUserIds: number[] = [];

  function missionContext(missionId: number | string) {
    return { params: Promise.resolve({ missionId: String(missionId) }) };
  }

  function idContext(id: number | string) {
    return { params: Promise.resolve({ id: String(id) }) };
  }

  /** The headers `src/middleware.ts` attaches from a verified token's claims. */
  function authHeaders(userId: number, role: UserRole): Record<string, string> {
    return { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role };
  }

  function getRequest(url: string, userId: number, role: UserRole): Request {
    return new Request(url, { headers: authHeaders(userId, role) });
  }

  function jsonRequest(url: string, body: unknown, userId: number, role: UserRole): Request {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(userId, role) },
      body: JSON.stringify(body),
    });
  }

  function deleteRequest(url: string, userId: number, role: UserRole): Request {
    return new Request(url, { method: "DELETE", headers: authHeaders(userId, role) });
  }

  async function registerTestUser(role: UserRole, label: string): Promise<number> {
    const response = await registerRoute(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: `bid-${label}-${emailCounter + 1}`,
          email: uniqueEmail(label),
          password: "password123",
          role,
        }),
      }),
      listContext,
    );
    const body = await response.json();
    expect(response.status).toBe(201);
    insertedUserIds.push(body.id);
    return body.id as number;
  }

  /** An ISO instant for a *local* wall-clock time (see the missions live suite). */
  function localInstant(year: number, month: number, day: number, hour: number): string {
    return new Date(year, month - 1, day, hour).toISOString();
  }

  /**
   * Creates a PUBLISHED mission through the real endpoint. `biddingDeadline`
   * defaults to far enough out that the deadline rule never fires by accident;
   * the deadline case overrides it.
   */
  async function createMission(designerId: number, overrides: Record<string, unknown> = {}) {
    const response = await createMissionRoute(
      jsonRequest(
        "http://localhost/api/v1/missions",
        {
          name: `Bid target ${runId}`,
          description: `Bid integration fixture ${runId}`,
          status: "PUBLISHED",
          startTime: localInstant(2030, 9, 1, 8),
          endTime: localInstant(2030, 9, 1, 10),
          location: `Novi Sad ${runId}`,
          biddingDeadline: "2030-08-25",
          waypoints: [
            { lat: 45.2671, lng: 19.8335, altitude: 60, action: "PHOTO" },
            { lat: 45.2681, lng: 19.8345, altitude: 80, action: "HOVER", hoverDurationSeconds: 30 },
          ],
          ...overrides,
        },
        designerId,
        "DESIGNER",
      ),
      listContext,
    );
    const body = await response.json();
    expect(response.status).toBe(201);
    return body as { id: number; status: string };
  }

  /** POSTs a bid as the given pilot and returns the raw response. */
  async function placeBid(
    missionId: number,
    pilotId: number,
    body: { amount?: unknown; message?: unknown },
  ): Promise<Response> {
    return placeRoute(
      jsonRequest(`http://localhost/api/v1/bids/mission/${missionId}`, body, pilotId, "PILOT"),
      missionContext(missionId),
    );
  }

  /** Every audit row written about one bid, in no particular order. */
  async function auditRowsFor(bidId: number) {
    return getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetType, "BID"), eq(auditLog.targetId, bidId)));
  }

  let designerId: number;
  let pilotId: number;
  let otherPilotId: number;

  beforeAll(async () => {
    designerId = await registerTestUser("DESIGNER", "designer");
    pilotId = await registerTestUser("PILOT", "pilot");
    otherPilotId = await registerTestUser("PILOT", "other-pilot");
  });

  afterAll(async () => {
    if (insertedUserIds.length > 0) {
      // Bids first (`fk_bid_pilot` does not cascade), then the missions they
      // hung off, then the actors. Audit rows deliberately outlive their actor
      // (see `audit_log`'s doc comment in db/schema.ts), so they go explicitly.
      await getDb().delete(bid).where(inArray(bid.pilotId, insertedUserIds));
      await getDb().delete(mission).where(inArray(mission.userId, insertedUserIds));
      await getDb().delete(auditLog).where(inArray(auditLog.actorId, insertedUserIds));
      await getDb().delete(users).where(inArray(users.id, insertedUserIds));
    }
    await closeDb();
  });

  describe("POST /api/v1/bids/mission/{missionId}", () => {
    it("persists the bid, flips the PUBLISHED mission to BIDDING, and audits the placement", async () => {
      const target = await createMission(designerId);
      expect(target.status).toBe("PUBLISHED");

      const response = await placeBid(target.id, pilotId, {
        amount: 1200.5,
        message: "Two-day photogrammetry pass",
      });
      const body = await response.json();

      // 200, not 201: the source returns `ResponseEntity.ok(...)` because the
      // same call updates an existing bid just as often as it creates one.
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        missionId: target.id,
        // Resolved server-side off the joins, never sent by the client.
        missionName: `Bid target ${runId}`,
        pilotId,
        amount: 1200.5,
        message: "Two-day photogrammetry pass",
        status: "PENDING",
      });
      expect(body.pilotName).toMatch(/^bid-pilot-/);

      const [row] = await getDb().select().from(bid).where(eq(bid.id, body.id));
      // `numeric(12, 2)` keeps the scale in the database; the wire value is the
      // narrowed number.
      expect(row.amount).toBe("1200.50");
      expect(row.status).toBe("PENDING");

      // The rule this case exists for: the first bid moves the mission's
      // lifecycle on, and `place()` loads through `findFresh` precisely so this
      // write is over a live row rather than a cached snapshot.
      const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, target.id));
      expect(missionRow.status).toBe("BIDDING");

      const audits = await auditRowsFor(body.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorId: pilotId,
        actorRole: "PILOT",
        action: "BID_PLACED",
        targetType: "BID",
        details: `1200.5 on "Bid target ${runId}"`,
      });
    });

    it("updates the pilot's existing bid in place and marks the audit row (updated)", async () => {
      const target = await createMission(designerId);
      const first = await (await placeBid(target.id, pilotId, { amount: 900 })).json();

      const response = await placeBid(target.id, pilotId, {
        amount: 850,
        message: "Sharpened after the site visit",
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      // Same row, not a second one — `bid_mission_pilot_unique` allows exactly
      // one bid per pilot per mission, and `place()` upserts into it.
      expect(body.id).toBe(first.id);
      expect(body.amount).toBe(850);
      expect(body.message).toBe("Sharpened after the site visit");
      expect(await getDb().select().from(bid).where(eq(bid.missionId, target.id))).toHaveLength(1);

      // Already BIDDING from the first bid: the status write is conditional, so
      // nothing regresses on the second.
      const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, target.id));
      expect(missionRow.status).toBe("BIDDING");

      const audits = await auditRowsFor(body.id);
      expect(audits).toHaveLength(2);
      const details = audits.map((entry) => entry.details).sort();
      expect(details).toEqual([
        `850 on "Bid target ${runId}" (updated)`,
        `900 on "Bid target ${runId}"`,
      ]);
      // The suffix is the whole point: "raised an existing bid" is worth
      // telling apart from a first offer.
      expect(details[0]?.endsWith(" (updated)")).toBe(true);
    });

    it("renders and logs the new-bid email instead of sending it when MAIL_ENABLED is false, without breaking the bid", async () => {
      // The default this app ships with (`src/lib/env.ts`), and the one the
      // test env runs under — asserted so a leaked `MAIL_ENABLED=true` fails
      // here with a reason rather than as a puzzling absent log line.
      expect(env.MAIL_ENABLED).toBe(false);
      const target = await createMission(designerId);
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

      let response: Response;
      let logged: string[] = [];
      try {
        response = await placeBid(target.id, pilotId, { amount: 640, message: "Thermal included" });
      } finally {
        // Read the calls *before* restoring: `mockRestore()` also clears them.
        logged = infoSpy.mock.calls.map((call) => String(call[1] ?? ""));
        infoSpy.mockRestore();
      }
      const body = await response.json();

      // The send is best-effort and awaited inside `place()`: if the disabled
      // branch (or the React Email render before it) threw, the bid would not
      // have been returned at all.
      expect(response.status).toBe(200);
      expect(body.amount).toBe(640);
      expect(await getDb().select().from(bid).where(eq(bid.id, body.id))).toHaveLength(1);

      const mailLine = logged.find((message) => message.startsWith("[mail disabled]"));
      expect(mailLine).toBeDefined();
      // Addressed to the mission's owner, with the subject the Thymeleaf port
      // builds — and the rendered HTML, which is what the disabled branch is
      // for.
      expect(mailLine).toContain(`subject="New bid on "Bid target ${runId}""`);
      expect(mailLine).toContain("Thermal included");
    });

    it("hides a moderated mission behind a 404 and writes no bid", async () => {
      const target = await createMission(designerId);
      await getDb().update(mission).set({ moderation: "HIDDEN" }).where(eq(mission.id, target.id));

      const response = await placeBid(target.id, pilotId, { amount: 500 });

      // Not a 403: a mission the caller may not bid on must be
      // indistinguishable from one that does not exist, or the status code
      // itself would confirm the id.
      expect(response.status).toBe(404);
      expect((await response.json()).status).toBe("NOT_FOUND");
      expect(await getDb().select().from(bid).where(eq(bid.missionId, target.id))).toEqual([]);
      // And the mission's own status is untouched — nothing flipped to BIDDING.
      const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, target.id));
      expect(missionRow.status).toBe("PUBLISHED");
    });

    it("hides a suspended designer's mission behind the same 404", async () => {
      const doomedDesigner = await registerTestUser("DESIGNER", "suspended-designer");
      const target = await createMission(doomedDesigner);
      await getDb().update(users).set({ suspended: true }).where(eq(users.id, doomedDesigner));

      const response = await placeBid(target.id, pilotId, { amount: 500 });

      // The designer join is re-read by `findFresh` on every place, so the
      // suspension takes effect immediately — no cache stands between it and
      // this call.
      expect(response.status).toBe(404);
      expect(await getDb().select().from(bid).where(eq(bid.missionId, target.id))).toEqual([]);
    });

    it("refuses a suspended pilot with 403 and writes neither a bid nor an audit row", async () => {
      const suspendedPilot = await registerTestUser("PILOT", "suspended-pilot");
      await getDb().update(users).set({ suspended: true }).where(eq(users.id, suspendedPilot));
      const target = await createMission(designerId);

      const response = await placeBid(target.id, suspendedPilot, { amount: 500 });

      expect(response.status).toBe(403);
      expect((await response.json()).status).toBe("FORBIDDEN");
      expect(await getDb().select().from(bid).where(eq(bid.pilotId, suspendedPilot))).toEqual([]);
      // Nothing bid-shaped was recorded. (Their USER_REGISTERED row from
      // signing up is still there — the filter is on the target type, not the
      // actor, so this stays an assertion about `place()`.)
      expect(
        await getDb()
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.actorId, suspendedPilot), eq(auditLog.targetType, "BID"))),
      ).toEqual([]);
      // The moderation check runs first, so a *hidden* mission still reads as
      // 404 to this same pilot rather than leaking the suspension.
      const hidden = await createMission(designerId);
      await getDb().update(mission).set({ moderation: "HIDDEN" }).where(eq(mission.id, hidden.id));
      expect((await placeBid(hidden.id, suspendedPilot, { amount: 500 })).status).toBe(404);
    });

    it("409s once the bidding deadline has passed, while the deadline day itself stays open", async () => {
      const openToday = await createMission(designerId);
      const closed = await createMission(designerId);
      // Written straight to the `date` column: the request schema accepts any
      // calendar day, and these two have to be pinned relative to *today*.
      await getDb()
        .update(mission)
        .set({ biddingDeadline: today() })
        .where(eq(mission.id, openToday.id));
      await getDb()
        .update(mission)
        .set({ biddingDeadline: daysFromToday(-1) })
        .where(eq(mission.id, closed.id));

      // `LocalDate.now().isAfter(deadline)` — the deadline day is not yet past.
      expect((await placeBid(openToday.id, pilotId, { amount: 400 })).status).toBe(200);

      const response = await placeBid(closed.id, pilotId, { amount: 400 });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.status).toBe("CONFLICT");
      expect(body.message).toBe(`The bidding deadline for mission ${closed.id} has passed`);
      expect(await getDb().select().from(bid).where(eq(bid.missionId, closed.id))).toEqual([]);
    });

    it("409s on a mission that is no longer open for bidding", async () => {
      const target = await createMission(designerId);
      // The state a Phase-5 award leaves behind; written directly because the
      // lifecycle endpoints do not exist yet.
      await getDb().update(mission).set({ status: "AWARDED" }).where(eq(mission.id, target.id));

      const response = await placeBid(target.id, pilotId, { amount: 400 });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.message).toBe(`Mission ${target.id} is not open for bidding`);
      expect(await getDb().select().from(bid).where(eq(bid.missionId, target.id))).toEqual([]);
    });
  });

  describe("GET /api/v1/bids/mission/{missionId}", () => {
    it("gives the owning designer every bid newest-first, and any other pilot only their own", async () => {
      const target = await createMission(designerId);
      const mine = await (await placeBid(target.id, pilotId, { amount: 700 })).json();
      const theirs = await (await placeBid(target.id, otherPilotId, { amount: 650 })).json();

      const ownerResponse = await listRoute(
        getRequest(`http://localhost/api/v1/bids/mission/${target.id}`, designerId, "DESIGNER"),
        missionContext(target.id),
      );
      const ownerBody = await ownerResponse.json();

      expect(ownerResponse.status).toBe(200);
      expect(ownerBody.map((b: { id: number }) => b.id)).toEqual([theirs.id, mine.id]);
      // Each row names its pilot, off the join — the designer's list is the
      // only place those names are shown.
      expect(ownerBody.map((b: { pilotId: number }) => b.pilotId)).toEqual([otherPilotId, pilotId]);

      const pilotResponse = await listRoute(
        getRequest(`http://localhost/api/v1/bids/mission/${target.id}`, pilotId, "PILOT"),
        missionContext(target.id),
      );
      const pilotBody = await pilotResponse.json();

      // The same endpoint feeds the pilot's "your bid" panel: their own bid and
      // nothing else, so a competitor's price is never disclosed.
      expect(pilotResponse.status).toBe(200);
      expect(pilotBody.map((b: { id: number }) => b.id)).toEqual([mine.id]);

      // A designer who does not own the mission is "anyone else" too, and has
      // no bid of their own: an empty list, not a 403.
      const strangerResponse = await listRoute(
        getRequest(`http://localhost/api/v1/bids/mission/${target.id}`, otherPilotId, "PILOT"),
        missionContext(target.id),
      );
      expect((await strangerResponse.json()).map((b: { id: number }) => b.id)).toEqual([theirs.id]);
    });

    it("404s for a mission that does not exist", async () => {
      const response = await listRoute(
        getRequest("http://localhost/api/v1/bids/mission/999999999", pilotId, "PILOT"),
        missionContext(999999999),
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/v1/bids/my", () => {
    it("returns the caller's bids across missions, newest first, with each mission's name", async () => {
      const historyPilot = await registerTestUser("PILOT", "history");
      const first = await createMission(designerId, { name: `History one ${runId}` });
      const second = await createMission(designerId, { name: `History two ${runId}` });
      const older = await (await placeBid(first.id, historyPilot, { amount: 210 })).json();
      const newer = await (await placeBid(second.id, historyPilot, { amount: 220 })).json();

      const response = await myBidsRoute(
        getRequest("http://localhost/api/v1/bids/my", historyPilot, "PILOT"),
        listContext,
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.map((b: { id: number }) => b.id)).toEqual([newer.id, older.id]);
      expect(body.map((b: { missionName: string }) => b.missionName)).toEqual([
        `History two ${runId}`,
        `History one ${runId}`,
      ]);
    });
  });

  describe("DELETE /api/v1/bids/{id}", () => {
    it("deletes the row, audits the withdrawal from the pre-delete snapshot, and 404s the second time", async () => {
      const target = await createMission(designerId, { name: `Withdrawable ${runId}` });
      const placed = await (
        await placeBid(target.id, pilotId, { amount: 1500, message: "Withdraw me" })
      ).json();

      const response = await withdrawRoute(
        deleteRequest(`http://localhost/api/v1/bids/${placed.id}`, pilotId, "PILOT"),
        idContext(placed.id),
      );

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(await getDb().select().from(bid).where(eq(bid.id, placed.id))).toEqual([]);

      // The row is gone, so this entry — snapshotting amount and mission name —
      // is all that is left of the bid.
      const audits = await auditRowsFor(placed.id);
      const withdrawal = audits.find((entry) => entry.action === "BID_WITHDRAWN");
      expect(withdrawal).toMatchObject({
        actorId: pilotId,
        actorRole: "PILOT",
        targetType: "BID",
        targetId: placed.id,
        details: `1500 on "Withdrawable ${runId}"`,
      });

      const second = await withdrawRoute(
        deleteRequest(`http://localhost/api/v1/bids/${placed.id}`, pilotId, "PILOT"),
        idContext(placed.id),
      );
      expect(second.status).toBe(404);
    });

    it("reports another pilot's bid as not found and leaves it standing", async () => {
      const target = await createMission(designerId);
      const theirs = await (await placeBid(target.id, otherPilotId, { amount: 480 })).json();

      const response = await withdrawRoute(
        deleteRequest(`http://localhost/api/v1/bids/${theirs.id}`, pilotId, "PILOT"),
        idContext(theirs.id),
      );

      // 404, not 403: a bid that is not the caller's own must read exactly like
      // one that does not exist, so bid ids cannot be probed.
      expect(response.status).toBe(404);
      expect((await response.json()).status).toBe("NOT_FOUND");
      expect(await getDb().select().from(bid).where(eq(bid.id, theirs.id))).toHaveLength(1);
      expect(
        (await auditRowsFor(theirs.id)).some((entry) => entry.action === "BID_WITHDRAWN"),
      ).toBe(false);
    });

    it("409s on a bid that has already been decided, and keeps the row", async () => {
      const target = await createMission(designerId);
      const placed = await (await placeBid(target.id, pilotId, { amount: 999 })).json();
      // The state Phase 5's accept flow will produce; written directly because
      // that endpoint does not exist yet.
      await getDb().update(bid).set({ status: "REJECTED" }).where(eq(bid.id, placed.id));

      const response = await withdrawRoute(
        deleteRequest(`http://localhost/api/v1/bids/${placed.id}`, pilotId, "PILOT"),
        idContext(placed.id),
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.message).toBe(
        `Bid ${placed.id} has already been decided and cannot be withdrawn`,
      );
      expect(await getDb().select().from(bid).where(eq(bid.id, placed.id))).toHaveLength(1);
    });
  });

  describe("POST /api/v1/bids/{id}/accept", () => {
    /** POSTs the award as the given user; no body, exactly as the client sends it. */
    async function acceptBid(bidId: number, userId: number, role: UserRole = "DESIGNER") {
      return acceptRoute(
        new Request(`http://localhost/api/v1/bids/${bidId}/accept`, {
          method: "POST",
          headers: authHeaders(userId, role),
        }),
        idContext(bidId),
      );
    }

    it("accepts the winner, rejects the other bids, awards the mission, and notifies both pilots", async () => {
      const target = await createMission(designerId, { name: `Awardable ${runId}` });
      const winning = await (
        await placeBid(target.id, pilotId, { amount: 1000, message: "Pick me" })
      ).json();
      const losing = await (await placeBid(target.id, otherPilotId, { amount: 1100 })).json();
      // Read the mission once *before* the award so the caching DAO holds a
      // pre-award snapshot: the post-commit eviction is what the last
      // assertion in this case is really about.
      await missionDetailRoute(
        getRequest(`http://localhost/api/v1/missions/${target.id}`, designerId, "DESIGNER"),
        idContext(target.id),
      );

      const response = await acceptBid(winning.id, designerId);
      const body = await response.json();

      // The response is the single accepted bid — the source returns
      // `BidResponse`, not the mission and not the losers.
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ id: winning.id, pilotId, status: "ACCEPTED" });

      const rows = await getDb().select().from(bid).where(eq(bid.missionId, target.id));
      expect(rows.find((row) => row.id === winning.id)?.status).toBe("ACCEPTED");
      // Every *other* pending bid loses, in the same transaction.
      expect(rows.find((row) => row.id === losing.id)?.status).toBe("REJECTED");

      const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, target.id));
      expect(missionRow.status).toBe("AWARDED");
      expect(missionRow.awardedPilotId).toBe(pilotId);

      // One notification each, addressed by outcome.
      const [winnerNote] = await getDb()
        .select()
        .from(notification)
        .where(and(eq(notification.userId, pilotId), eq(notification.missionId, target.id)));
      expect(winnerNote).toMatchObject({
        type: "BID_ACCEPTED",
        title: "Bid accepted",
        message: `Your bid on "Awardable ${runId}" was accepted — the mission is yours.`,
      });
      const [loserNote] = await getDb()
        .select()
        .from(notification)
        .where(and(eq(notification.userId, otherPilotId), eq(notification.missionId, target.id)));
      expect(loserNote).toMatchObject({
        type: "BID_REJECTED",
        title: "Bid not selected",
        message: `Your bid on "Awardable ${runId}" wasn't selected.`,
      });

      // Audited once, against the accepted bid, by the awarding designer.
      const accepted = (await auditRowsFor(winning.id)).filter(
        (entry) => entry.action === "BID_ACCEPTED",
      );
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({
        actorId: designerId,
        actorRole: "DESIGNER",
        targetType: "BID",
        details: `1000 on "Awardable ${runId}"`,
      });
      // Nothing new was audited about the loser — only its own placement is
      // there. The source records the acceptance and nothing about the
      // rejections it cascades, so there is no audit action for one.
      expect((await auditRowsFor(losing.id)).map((entry) => entry.action)).toEqual(["BID_PLACED"]);

      // The cached pre-award copy was dropped after the commit, so the very
      // next read of the mission already reports the award.
      const detail = await missionDetailRoute(
        getRequest(`http://localhost/api/v1/missions/${target.id}`, designerId, "DESIGNER"),
        idContext(target.id),
      );
      expect((await detail.json()).status).toBe("AWARDED");
    });

    it("refuses a designer who does not own the mission with 403, leaving every bid pending", async () => {
      const stranger = await registerTestUser("DESIGNER", "stranger");
      const target = await createMission(designerId);
      const placed = await (await placeBid(target.id, pilotId, { amount: 300 })).json();

      const response = await acceptBid(placed.id, stranger);
      const body = await response.json();

      // 403, not 404: the ownership check runs before both conflict checks, so
      // this is also what a stranger sees on an already-awarded mission.
      expect(response.status).toBe(403);
      expect(body).toMatchObject({
        status: "FORBIDDEN",
        message: `You are not allowed to modify mission ${target.id}`,
      });
      const [row] = await getDb().select().from(bid).where(eq(bid.id, placed.id));
      expect(row.status).toBe("PENDING");
      const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, target.id));
      expect(missionRow.status).toBe("BIDDING");
      expect(missionRow.awardedPilotId).toBeNull();
    });

    it("rejects a pilot with 403 before the service is reached (hasRole('DESIGNER'))", async () => {
      const target = await createMission(designerId);
      const placed = await (await placeBid(target.id, pilotId, { amount: 300 })).json();

      // Not even the bid's own pilot may accept it.
      const response = await acceptBid(placed.id, pilotId, "PILOT");

      expect(response.status).toBe(403);
      const [row] = await getDb().select().from(bid).where(eq(bid.id, placed.id));
      expect(row.status).toBe("PENDING");
    });

    it("409s while the bid's pilot is suspended, and freezes the bid rather than rejecting it", async () => {
      const frozenPilot = await registerTestUser("PILOT", "frozen");
      const target = await createMission(designerId);
      const placed = await (await placeBid(target.id, frozenPilot, { amount: 700 })).json();
      await getDb().update(users).set({ suspended: true }).where(eq(users.id, frozenPilot));

      const response = await acceptBid(placed.id, designerId);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.status).toBe("CONFLICT");
      expect(body.message).toBe(
        `Bid ${placed.id} cannot be accepted while its pilot is suspended`,
      );
      // Frozen, not rejected — reactivating the account makes it acceptable
      // again, so nothing about the bid or the mission may have moved.
      const [row] = await getDb().select().from(bid).where(eq(bid.id, placed.id));
      expect(row.status).toBe("PENDING");
      const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, target.id));
      expect(missionRow.status).toBe("BIDDING");

      // And it goes through once the suspension is lifted.
      await getDb().update(users).set({ suspended: false }).where(eq(users.id, frozenPilot));
      expect((await acceptBid(placed.id, designerId)).status).toBe(200);
    });

    it("409s on a second award, because the mission is no longer open", async () => {
      const target = await createMission(designerId);
      const first = await (await placeBid(target.id, pilotId, { amount: 500 })).json();
      const second = await (await placeBid(target.id, otherPilotId, { amount: 550 })).json();
      expect((await acceptBid(first.id, designerId)).status).toBe(200);

      const response = await acceptBid(second.id, designerId);
      const body = await response.json();

      // The mission guard fires before the bid-status one, so this is the
      // message even though `second` is REJECTED by now.
      expect(response.status).toBe(409);
      expect(body.message).toBe(`Mission ${target.id} has already been awarded`);
      const [missionRow] = await getDb().select().from(mission).where(eq(mission.id, target.id));
      expect(missionRow.awardedPilotId).toBe(pilotId);
    });

    it("404s for a bid that does not exist", async () => {
      const response = await acceptBid(999999999, designerId);

      expect(response.status).toBe(404);
      expect((await response.json()).status).toBe("NOT_FOUND");
    });
  });
});

/**
 * Today as `yyyy-MM-dd` in the server's local zone — the same calendar day
 * `BidService`'s deadline check builds, so the fixtures below straddle the
 * boundary the way the source does rather than by UTC.
 */
function today(): string {
  return daysFromToday(0);
}

function daysFromToday(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

describe.skipIf(hasDb)("bid routes (live DB)", () => {
  it("skipped — no DATABASE_URL configured", () => {
    expect(hasDb).toBe(false);
  });
});
