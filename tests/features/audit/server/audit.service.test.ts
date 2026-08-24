import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page, PageRequest } from "@/lib/api/paging";
import type { AuditLog, AuditSearchFilters } from "@/features/audit/audit.types";

/**
 * Vitest suite for `audit.service.ts`.
 *
 * Mirrors the one `AuditServiceTest` case that belongs to this module —
 * `searchIsNormalizedToALowercasePatternAndBlankMeansEverything`. The suite's
 * other case, `recordMapsEveryFieldOntoTheSavedRow`, covers the write half of
 * the Java service, which this port keeps in `src/lib/audit.ts` (shared core);
 * it is exercised by the feature suites that record rows, and by the audit
 * factories' own assertions there.
 *
 * `audit.queries.ts` is mocked, standing in for the Java test's
 * `@Mock AuditLogRepository`: the assertions are about what the service hands
 * the repository, exactly as the Java `verify(repository).search(...)` calls
 * are. The filters travel untouched and only `q` is transformed, so the
 * service's whole contract is that transformation plus the pass-through.
 *
 * What the mock necessarily hides — that the pattern it hands over really does
 * match the rows an admin is looking for, over real SQL — lives in
 * `audit.queries.test.ts` (live DB), with the endpoint on top of it in
 * `src/app/api/v1/audit-log/routes.live.test.ts`.
 *
 * SOURCE:
 * - drone-missions-backend/.../src/test/.../business/service/audit/AuditServiceTest.java
 * - drone-missions-backend/.../business/service/audit/AuditService.java (`search`)
 */

const searchMock = vi.fn();
vi.mock("@/features/audit/audit.queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/audit/audit.queries")>();
  return { ...actual, search: (...args: unknown[]) => searchMock(...args) };
});

// `vi.mock` is hoisted, so this already resolves against the mocked module.
import { search } from "@/features/audit/audit.service";

/** `PageRequest.of(0, 20)` — the pageable the Java test threads through. */
const pageable: PageRequest = { page: 0, size: 20 };

const emptyPage: Page<AuditLog> = { content: [], request: pageable, totalElements: 0 };

/** The filter object the query layer receives; `null` everywhere means "everything". */
function filters(overrides: Partial<AuditSearchFilters> = {}): AuditSearchFilters {
  return { actorId: null, action: null, actorRole: null, pattern: null, ...overrides };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("audit.service.ts search", () => {
  // Mirrors `searchIsNormalizedToALowercasePatternAndBlankMeansEverything`.
  it("turns a blank q into no pattern at all", async () => {
    searchMock.mockResolvedValue(emptyPage);

    await search(null, null, null, "   ", pageable);

    expect(searchMock).toHaveBeenCalledWith(filters(), pageable);
  });

  // The second half of the same Java case.
  it("trims, lowercases and wraps q into a %…% LIKE pattern", async () => {
    searchMock.mockResolvedValue(emptyPage);

    await search(null, null, null, " Orchard ", pageable);

    expect(searchMock).toHaveBeenCalledWith(filters({ pattern: "%orchard%" }), pageable);
  });

  /**
   * Not a case in the Java suite, but the same branch its `q == null` guard
   * covers — and the one the route actually takes, since an absent `?q` is
   * `null` there. Worth pinning because "no filter" is the value most at risk
   * of being quietly turned into `"%null%"` on the way through.
   */
  it("treats an absent q as no pattern", async () => {
    searchMock.mockResolvedValue(emptyPage);

    await search(null, null, null, null, pageable);
    await search(null, null, null, undefined, pageable);

    expect(searchMock).toHaveBeenNthCalledWith(1, filters(), pageable);
    expect(searchMock).toHaveBeenNthCalledWith(2, filters(), pageable);
  });

  /**
   * The pass-through half of the Java case: the other three filters are
   * handed to the repository untouched, and `q`'s normalisation does not
   * disturb them. `role` becomes the query layer's `actorRole`, the column it
   * filters on.
   */
  it("passes actorId, action and role straight through alongside the pattern", async () => {
    const request: PageRequest = { page: 2, size: 5 };
    searchMock.mockResolvedValue({ content: [], request, totalElements: 0 });

    await search(9, "USER_SUSPENDED", "PILOT", "orchard", request);

    expect(searchMock).toHaveBeenCalledWith(
      { actorId: 9, action: "USER_SUSPENDED", actorRole: "PILOT", pattern: "%orchard%" },
      request,
    );
  });

  /** Wildcards are deliberately unescaped — the source says so ("like the mission feed's keyword"). */
  it("leaves LIKE wildcards in q unescaped", async () => {
    searchMock.mockResolvedValue(emptyPage);

    await search(null, null, null, "or%ard_", pageable);

    expect(searchMock).toHaveBeenCalledWith(filters({ pattern: "%or%ard_%" }), pageable);
  });

  it("returns the page the query layer produced, unmodified", async () => {
    searchMock.mockResolvedValue(emptyPage);

    const result = await search(null, null, null, null, pageable);

    expect(result).toBe(emptyPage);
  });
});
