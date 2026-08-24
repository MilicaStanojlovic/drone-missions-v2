import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { USER_ID_HEADER, USER_ROLE_HEADER } from "@/lib/auth/guards";
import type { Page } from "@/lib/api/paging";
import type { UserRole } from "@/db/schema";
import type { AuditLog } from "@/features/audit/audit.types";

/**
 * Route-level suite for `GET /api/v1/audit-log`.
 *
 * Mirrors `AuditLogControllerTest`, which is a Mockito unit test of the
 * controller rather than a live-database one: `AuditService` is mocked so the
 * assertions are about what the *web layer* does — the filters and page request
 * it hands the service, the envelope it wraps the answer in, the response shape
 * the mapper produces, and the authorization it enforces. Same shape as the
 * neighbouring `users/routes.test.ts` and `missions/routes.test.ts`; the
 * service's own behavior (the `q` normalisation) has its suite in
 * `src/features/audit/audit.service.test.ts`.
 *
 * The mapper is deliberately **not** mocked, exactly as the Java test passes a
 * real `new AuditLogMapper()` into the controller — the mapping is part of what
 * `listMapsRowsIntoThePagedEnvelope` asserts.
 *
 * The 401 case goes through `middleware()` itself, the layer that actually
 * rejects an anonymous caller in the deployed app (this path is not in its
 * `PUBLIC_PATHS`), following the precedent of the other route suites. The 403
 * cases call the handler with a verified non-admin's headers, since
 * `requireRole()` is what stands in for `@PreAuthorize("hasRole('ADMIN')")` —
 * a case the Java suite has no counterpart for, since Mockito unit tests of a
 * controller bypass method security entirely.
 *
 * The same endpoint reading a trail that other endpoints really wrote — the
 * half a stubbed service cannot show — is in `routes.live.test.ts` beside this
 * file, over the SQL rules pinned in `src/features/audit/audit.queries.test.ts`.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/controller/audit/AuditLogController.java
 * - test .../web/controller/audit/AuditLogControllerTest.java
 */

const searchMock = vi.fn();
vi.mock("@/features/audit/audit.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/audit/audit.service")>();
  return { ...actual, search: (...args: unknown[]) => searchMock(...args) };
});

// `vi.mock` is hoisted, so these already resolve against the mocked module.
import { middleware } from "@/middleware";
import { GET as listRoute } from "@/app/api/v1/audit-log/route";

const ADMIN_ID = 9;

/** The context Next.js hands a non-dynamic route handler. */
const listContext = { params: Promise.resolve({}) };

/** The headers `src/middleware.ts` attaches from a verified token's claims. */
function request(url: string, userId = ADMIN_ID, role: UserRole = "ADMIN"): Request {
  return new Request(url, {
    headers: { [USER_ID_HEADER]: String(userId), [USER_ROLE_HEADER]: role },
  });
}

/**
 * The Java test's `row()` helper: audit row 1, actor 9 ("admin"), a
 * MISSION_HIDDEN entry against mission 4 whose details quote the mission name,
 * stamped at the epoch.
 */
function fakeRow(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 1,
    actorId: ADMIN_ID,
    actorUsername: "admin",
    actorRole: "ADMIN",
    action: "MISSION_HIDDEN",
    targetType: "MISSION",
    targetId: 4,
    details: '"Orchard survey"',
    createdAt: new Date("1970-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** `new PageImpl<>(List.of(row), pageable, total)`. */
function page(
  content: AuditLog[],
  pageIndex: number,
  size: number,
  totalElements: number,
): Page<AuditLog> {
  return { content, request: { page: pageIndex, size }, totalElements };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/audit-log", () => {
  // Mirrors `listMapsRowsIntoThePagedEnvelope`.
  it("maps rows into the paged envelope", async () => {
    searchMock.mockResolvedValue(page([fakeRow()], 0, 20, 1));

    const response = await listRoute(request("http://localhost/api/v1/audit-log"), listContext);
    const body = await response.json();

    expect(searchMock).toHaveBeenCalledWith(null, null, null, null, { page: 0, size: 20 });
    expect(response.status).toBe(200);
    expect(body.content).toHaveLength(1);
    expect(body.content[0].actorId).toBe(9);
    expect(body.content[0].actorUsername).toBe("admin");
    expect(body.content[0].action).toBe("MISSION_HIDDEN");
    expect(body.content[0].targetId).toBe(4);
    expect(body.page.totalElements).toBe(1);
    // `PagedModel`'s remaining metadata, which the Angular pager reads.
    expect(body.page).toEqual({ size: 20, number: 0, totalElements: 1, totalPages: 1 });
  });

  /**
   * The full `AuditLogResponse` shape, field for field — the Angular
   * `AuditLogEntry` interface is typed against exactly these nine keys, and the
   * `Instant` is serialized as an ISO-8601 string the way Jackson serializes it.
   */
  it("answers the AuditLogResponse shape and nothing more", async () => {
    searchMock.mockResolvedValue(page([fakeRow()], 0, 20, 1));

    const response = await listRoute(request("http://localhost/api/v1/audit-log"), listContext);
    const body = await response.json();

    expect(body.content[0]).toEqual({
      id: 1,
      actorId: 9,
      actorUsername: "admin",
      actorRole: "ADMIN",
      action: "MISSION_HIDDEN",
      targetType: "MISSION",
      targetId: 4,
      details: '"Orchard survey"',
      createdAt: "1970-01-01T00:00:00.000Z",
    });
  });

  // Mirrors `filtersAndPageablePassThroughToTheService`.
  it("passes every filter and the page request through to the service", async () => {
    searchMock.mockResolvedValue(page([], 2, 5, 0));

    const response = await listRoute(
      request(
        "http://localhost/api/v1/audit-log?actorId=9&action=USER_SUSPENDED&role=PILOT&q=orchard&page=2&size=5",
      ),
      listContext,
    );

    expect(response.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith(9, "USER_SUSPENDED", "PILOT", "orchard", {
      page: 2,
      size: 5,
    });
  });

  /**
   * `q` reaches the service **raw**: the trimming/lowercasing/`%…%` wrapping is
   * `AuditService.search`'s job in the source, and this port keeps it there.
   */
  it("does not normalise q in the handler", async () => {
    searchMock.mockResolvedValue(page([], 0, 20, 0));

    await listRoute(request("http://localhost/api/v1/audit-log?q=%20Orchard%20"), listContext);

    expect(searchMock).toHaveBeenCalledWith(null, null, null, " Orchard ", { page: 0, size: 20 });
  });

  /**
   * The Angular filters are `<select>`s whose "All" option is `''`; Spring's
   * enum converter answers null for an empty string, so clearing a filter means
   * "everything" rather than a 400.
   */
  it("reads an empty filter value as no filter", async () => {
    searchMock.mockResolvedValue(page([], 0, 20, 0));

    await listRoute(
      request("http://localhost/api/v1/audit-log?actorId=&action=&role="),
      listContext,
    );

    expect(searchMock).toHaveBeenCalledWith(null, null, null, null, { page: 0, size: 20 });
  });

  it("rejects an unknown action with 400 and never reaches the service", async () => {
    const response = await listRoute(
      request("http://localhost/api/v1/audit-log?action=NONSENSE"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.status).toBe("BAD_REQUEST");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric actorId with 400", async () => {
    const response = await listRoute(
      request("http://localhost/api/v1/audit-log?actorId=abc"),
      listContext,
    );

    expect(response.status).toBe(400);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns an empty page (not 404) when nothing matches", async () => {
    searchMock.mockResolvedValue(page([], 0, 20, 0));

    const response = await listRoute(
      request("http://localhost/api/v1/audit-log?q=nothing-matches-this"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.content).toEqual([]);
    expect(body.page).toEqual({ size: 20, number: 0, totalElements: 0, totalPages: 0 });
  });

  it("rejects a designer with 403 and never reaches the service", async () => {
    const response = await listRoute(
      request("http://localhost/api/v1/audit-log", 7, "DESIGNER"),
      listContext,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      data: null,
      status: "FORBIDDEN",
      message: "You do not have permission to perform this action",
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("rejects a pilot with 403 — filtering by your own actorId does not buy you the trail", async () => {
    const response = await listRoute(
      request("http://localhost/api/v1/audit-log?actorId=3", 3, "PILOT"),
      listContext,
    );

    expect(response.status).toBe(403);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous request with 401 at the middleware layer", async () => {
    const response = await middleware(
      new NextRequest(new URL("http://localhost/api/v1/audit-log")),
    );
    expect(response.status).toBe(401);
  });
});
