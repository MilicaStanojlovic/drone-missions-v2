import "server-only";
import { and, count, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import { offsetOf, type Page, type PageRequest } from "@/lib/api/paging";
import type { AuditLog, AuditSearchFilters } from "./audit.types";

/**
 * Audit-log reads (replaces `data.repository.AuditLogRepository`).
 *
 * The interface's only declared query is `search`; the inherited
 * `JpaRepository.save` used by the write path is ported separately, in
 * `src/lib/audit.ts`'s `record()`.
 *
 * SOURCE: drone-missions-backend/.../data/repository/AuditLogRepository.java
 */

/**
 * The base read: every audit column plus the actor's username.
 *
 * The source's `select a from AuditLog a` does not join at all — Hibernate
 * resolves `a.actor` lazily when the mapper touches it, one query per distinct
 * actor. There is no lazy loading here, so the username is joined in up front:
 * the same rows, one query instead of N+1.
 *
 * A LEFT join, though `audit_log.actor_id` is `NOT NULL` with an FK
 * (`fk_audit_log_actor`), so it can never actually drop a row. The choice is
 * deliberate all the same: this table is the history, and a listing of it must
 * not be able to lose an entry to a join — `AuditLogMapper` is null-safe about
 * the actor for the same reason, and `audit.types.ts` keeps `actorUsername`
 * nullable to match.
 */
function selectEntries() {
  return getDb()
    .select({
      row: auditLog,
      actorUsername: users.username,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id));
}

/** Flattens a joined row into the `AuditLog` read shape. */
function toAuditLog(row: {
  row: typeof auditLog.$inferSelect;
  actorUsername: string | null;
}): AuditLog {
  return { ...row.row, actorUsername: row.actorUsername };
}

/**
 * Mirrors `AuditLogRepository.search` — the admin listing, filtered by any
 * combination of actor, action, actor role and a text pattern, paged and
 * newest first.
 *
 * Each of the source's four `:x is null or …` disjunctions becomes a predicate
 * that is simply **not added** when the filter is null: `and()` drops
 * `undefined` members, so an unsupplied filter contributes nothing to the SQL,
 * which reaches the database as the same query without that clause. (The
 * source has to write the `is null` form because JPQL binds all four
 * parameters whatever their value; the repository's own comment records what
 * that costs — `lower(:param)` there "breaks on PostgreSQL, which can't type a
 * null inside a function", which is exactly why the pattern is lowercased in
 * the service instead. Building the predicate list here keeps that property
 * for free.)
 *
 * The text filter stays **two LIKEs OR'd together, not a concat** — the other
 * warning in that comment: `details` is nullable, and `username || details`
 * would be NULL for every row without details, so a concat-based match would
 * silently hide exactly the rows a search is most likely to be looking for.
 *
 * `pattern` arrives as a ready lowercase `%…%` pattern (see `audit.service.ts`)
 * so no SQL function wraps the bind parameter, and `lower(col) LIKE` rather
 * than `ILIKE`, matching the source's JPQL. Wildcards inside it are not
 * escaped — a `%` typed into the admin filter widens the match here as it does
 * there.
 *
 * The `createdAt` DESC order is the `@PageableDefault(sort = "createdAt",
 * direction = DESC)` on `AuditLogController.list`; it lives here rather than
 * travelling in `PageRequest` for the reason `src/lib/api/paging.ts`
 * documents. `id DESC` is added as a tiebreaker, the same deviation
 * `user.queries.ts` and `mission.queries.ts` document — rows sharing a
 * `created_at` would otherwise be in an unspecified order, which under paging
 * can put one row on two pages or on none. Audit rows are the most likely of
 * all to share a timestamp: several are written inside the same request.
 *
 * The count is a second query against the same filter *and the same join* (so
 * an actor-username match is counted the same way it is listed), exactly as
 * Spring Data issues one for a `Page`. Both run concurrently: independent
 * reads, and a row inserted between them can at worst make `totalElements`
 * disagree with `content` by one — the same benign race Spring's sequential
 * pair has.
 */
export async function search(
  filters: AuditSearchFilters,
  request: PageRequest,
): Promise<Page<AuditLog>> {
  const conditions: (SQL | undefined)[] = [
    filters.actorId === null ? undefined : eq(auditLog.actorId, filters.actorId),
    filters.action === null ? undefined : eq(auditLog.action, filters.action),
    filters.actorRole === null ? undefined : eq(auditLog.actorRole, filters.actorRole),
    filters.pattern === null
      ? undefined
      : or(
          like(sql`lower(${users.username})`, filters.pattern),
          like(sql`lower(${auditLog.details})`, filters.pattern),
        ),
  ];
  const where = and(...conditions);

  const [rows, [total]] = await Promise.all([
    selectEntries()
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(request.size)
      .offset(offsetOf(request)),
    getDb()
      .select({ value: count() })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorId, users.id))
      .where(where),
  ]);

  return { content: rows.map(toAuditLog), request, totalElements: total?.value ?? 0 };
}
