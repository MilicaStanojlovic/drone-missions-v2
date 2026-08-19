import "server-only";
import type { auditLog, AuditActorRole, AuditAction, AuditTargetType } from "@/db/schema";

/**
 * Audit read-path types (replaces `data.model.AuditLog` as the *read* side
 * sees it, plus `web.dto.audit.AuditLogResponse`).
 *
 * The write side lives in `src/lib/audit.ts` (shared core, so every feature
 * can record without importing a feature) and owns `NewAuditEntry` +
 * `record()`. This module is the other half — what the admin listing reads
 * back — and belongs to a feature slice because it has a query, a service, a
 * mapper and a route of its own.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/model/AuditLog.java
 * - drone-missions-backend/.../web/dto/audit/AuditLogResponse.java
 */

/** One `audit_log` row exactly as stored — no actor resolved. */
export type AuditLogRow = typeof auditLog.$inferSelect;

/**
 * One audit row with its actor resolved — the ported shape of the Java entity
 * as the mapper consumes it (`log.getActorId()` and
 * `log.getActor().getUsername()`).
 *
 * Only the username is carried, not the whole account: those two fields are
 * everything `AuditLogMapper` reads off the association, and loading a full
 * `User` per row would drag the password hash through the read path for
 * nothing.
 *
 * `actorUsername` is nullable for the same reason the source mapper writes
 * `log.getActor() == null ? null : …`: the column is `NOT NULL` with an FK, so
 * a missing actor is not reachable today, but the read must not invent a name
 * if one ever is.
 */
export interface AuditLog extends AuditLogRow {
  actorUsername: string | null;
}

/**
 * The wire shape of one audit entry. Mirrors `AuditLogResponse`
 * field-for-field, and the Angular client's `AuditLogEntry`
 * (`src/app/models/audit.model.ts`) is typed against exactly this.
 *
 * `createdAt` is a `Date` here and an ISO-8601 string once
 * `NextResponse.json` serializes it — the same `Instant` -> string Jackson
 * performs, and what the Angular model documents.
 */
export interface AuditLogResponse {
  id: number;
  actorId: number;
  actorUsername: string | null;
  actorRole: AuditActorRole;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: number;
  details: string | null;
  createdAt: Date;
}

/**
 * The normalised filters for one audit search — what
 * `AuditLogRepository.search` receives after `AuditService.search` has done
 * its normalising.
 *
 * Every member is nullable and `null` uniformly means "not filtering", the
 * convention the source states in the repository's own javadoc ("Null filters
 * mean 'not filtering'"). `pattern` in particular arrives **ready**: a
 * lowercase `%…%` LIKE pattern built by the service, never a raw `q`.
 */
export interface AuditSearchFilters {
  /** Only rows this account acted on, or null for every actor. */
  actorId: number | null;
  /** Only rows recording this action, or null for every action. */
  action: AuditAction | null;
  /** Only rows whose snapshotted actor role matches, or null for every role. */
  actorRole: AuditActorRole | null;
  /** Ready lowercase `%…%` LIKE pattern matched against actor username OR details, or null. */
  pattern: string | null;
}
