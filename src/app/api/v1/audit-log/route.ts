import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/handler";
import { getCurrentUser, requireRole } from "@/lib/auth/guards";
import { mapPage, parsePageRequest, toPagedModel, type PagedModel } from "@/lib/api/paging";
import { toAuditLogResponse } from "@/features/audit/server/audit.mapper";
import { auditLogQuerySchema } from "@/features/audit/server/audit.schema";
import { search } from "@/features/audit/server/audit.service";
import type { AuditLogResponse } from "@/features/audit/audit.types";

/**
 * `GET /api/v1/audit-log` — the admin audit listing (replaces
 * `AuditLogController.list`).
 *
 * The read side of a trail every other endpoint writes to: one row per
 * state-changing action, newest first, filterable by actor (`?actorId`),
 * action (`?action`), the actor's snapshotted role (`?role`) and free text
 * (`?q`, matched against the actor's username *or* the row's `details`). Any
 * filter left off means "everything".
 *
 * Admin-only: `@PreAuthorize("hasRole('ADMIN')")` becomes an explicit
 * `requireRole()` here, in the handler, because it is a property of the
 * *endpoint* — the same split the users and missions admin routes document.
 * `AuditService.search` deliberately carries no role check of its own.
 *
 * `q` travels through this handler raw: trimming, lowercasing and the `%…%`
 * wrapping belong to the service in the source, and this port leaves them
 * there (see `audit.service.ts`).
 *
 * SOURCE: drone-missions-backend/.../web/controller/audit/AuditLogController.java,
 * test .../web/controller/audit/AuditLogControllerTest.java
 */
export const GET = withErrorHandling(async (request) => {
  const caller = getCurrentUser(request);
  const params = new URL(request.url).searchParams;
  // Parsed before the role check, matching the source's ordering: Spring
  // resolves `@RequestParam`/`Pageable` handler arguments in
  // `InvocableHandlerMethod` *before* the method-security advice around the
  // controller bean evaluates `@PreAuthorize`, so `?action=nonsense` is a 400
  // there whoever asks. Nothing observable happens before the check — parsing
  // is pure, and the query is behind it.
  const { actorId, action, role, q } = auditLogQuerySchema.parse({
    actorId: params.get("actorId"),
    action: params.get("action"),
    role: params.get("role"),
    q: params.get("q"),
  });
  // `@PageableDefault(size = 20, sort = "createdAt", direction = DESC)`: the
  // size default lives here, the sort in `audit.queries.ts` (see the "no
  // `sort`" note in `src/lib/api/paging.ts`).
  const pageRequest = parsePageRequest(params);
  requireRole(caller, "ADMIN");

  const page = await search(actorId ?? null, action ?? null, role ?? null, q, pageRequest);
  return NextResponse.json<PagedModel<AuditLogResponse>>(
    // `new PagedModel<>(service.search(...).map(mapper::toResponse))`.
    toPagedModel(mapPage(page, toAuditLogResponse)),
  );
});
