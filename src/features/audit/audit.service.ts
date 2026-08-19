import "server-only";
import type { AuditAction, AuditActorRole } from "@/db/schema";
import type { Page, PageRequest } from "@/lib/api/paging";
import { search as searchEntries } from "./audit.queries";
import type { AuditLog } from "./audit.types";

/**
 * Audit read service (replaces the `search` half of
 * `business.service.audit.AuditService`).
 *
 * The other half — `record`, the write path every feature calls as the last
 * statement of a successful mutation — lives in `src/lib/audit.ts` rather than
 * here, because it is shared core: putting it in this feature would make every
 * other feature import the audit *feature* to write a row. The split is
 * mechanical, not behavioural; between them the two modules are the whole Java
 * service.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/audit/AuditService.java (`search`)
 * - test .../business/service/audit/AuditServiceTest.java
 */

/**
 * The admin listing. Mirrors `AuditService.search`.
 *
 * Null (and, for `q`, blank) filters mean "everything" — the convention the
 * whole admin read path shares with `UserService.search` and
 * `MissionService.searchAll`.
 *
 * The one piece of logic is the LIKE pattern: `q` is trimmed, lowercased and
 * wrapped in `%…%` **here, not in the query**, which is what the source does
 * and what its repository comment insists on ("The LIKE pattern is lowercased
 * here, not in the query — lower(:param) breaks on PostgreSQL, which can't
 * type a null inside a function"). Wildcards inside `q` are left unescaped, so
 * a `%` typed into the admin filter is a wildcard — the source calls that out
 * as deliberate, "like the mission feed's keyword".
 *
 * No `requireRole()` here: the source gates this at the controller
 * (`@PreAuthorize("hasRole('ADMIN')")` on `AuditLogController.list`), and this
 * port keeps the gate at the same layer — the route handler.
 */
export async function search(
  actorId: number | null,
  action: AuditAction | null,
  role: AuditActorRole | null,
  q: string | null | undefined,
  request: PageRequest,
): Promise<Page<AuditLog>> {
  const trimmed = q === null || q === undefined ? "" : q.trim();
  // `q == null || q.isBlank() ? null : "%" + q.trim().toLowerCase() + "%"` —
  // `isBlank()` is true for whitespace-only input, which trimming to the empty
  // string reproduces exactly.
  const pattern = trimmed === "" ? null : `%${trimmed.toLowerCase()}%`;
  return searchEntries({ actorId, action, actorRole: role, pattern }, request);
}
