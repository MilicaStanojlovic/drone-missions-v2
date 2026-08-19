import "server-only";
import type { AuditLog, AuditLogResponse } from "./audit.types";

/**
 * Entity -> response DTO mapping (replaces `web.mapper.audit.AuditLogMapper`).
 *
 * SOURCE: drone-missions-backend/.../web/mapper/audit/AuditLogMapper.java
 */

/**
 * Shapes one audit row into the public `AuditLogResponse`.
 *
 * A flat, field-by-field copy, exactly as the source mapper is — including the
 * two null-safe members it takes off the actor association. Here the actor is
 * already resolved by the query's join (`actorId` is the column,
 * `actorUsername` the joined name), so `log.getActor() == null ? null : …`
 * becomes carrying the query's `null` straight through.
 *
 * Fields are whitelisted one by one rather than spread: the read shape is a
 * database row, and a spread would republish whatever column `audit_log`
 * gains next without anyone deciding to.
 */
export function toAuditLogResponse(log: AuditLog): AuditLogResponse {
  return {
    id: log.id,
    actorId: log.actorId,
    actorUsername: log.actorUsername,
    actorRole: log.actorRole,
    action: log.action,
    targetType: log.targetType,
    targetId: log.targetId,
    details: log.details,
    createdAt: log.createdAt,
  };
}
