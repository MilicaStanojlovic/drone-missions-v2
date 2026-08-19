import "server-only";
import { getDb } from "@/db/client";
import {
  auditLog,
  type AuditAction,
  type AuditActorRole,
  type AuditTargetType,
  type UserRole,
} from "@/db/schema";

/**
 * Audit write path (replaces `AuditService.record` + the `NewAuditEntry`
 * parameter-object factories).
 *
 * `record()` is the direct port of `AuditService.record`: callers invoke it
 * as the last statement after their domain save succeeds — a failed
 * operation never logs, and a failed insert propagates (an audit trail that
 * can be silently skipped is not one). This module only ships the two
 * factories Phase 1 needs (`userRegistered`/`userLoggedIn`, both
 * self-actored — the acting user is also the target); every other
 * `NewAuditEntry` factory (mission/bid/rating/admin actions) is added by the
 * phase that introduces the mutation it records.
 *
 * `AuditService.search` (the admin listing) is intentionally not ported here
 * — it belongs to the audit *read* path, which lands in Phase 7.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/audit/AuditService.java (`record` only)
 * - drone-missions-backend/.../business/service/audit/NewAuditEntry.java (`userRegistered`, `userLoggedIn`, `self`, `quoted`)
 * - drone-missions-backend/.../data/model/AuditAction.java
 * - drone-missions-backend/.../data/model/AuditTargetType.java
 */

/**
 * Parameter object for one audit row — mirrors the Java `NewAuditEntry`
 * record. `details` is optional (the DB column is nullable), matching
 * factories such as `userSuspended` that always populate it and none in
 * this phase that omit it, but callers are not required to supply one.
 */
export interface NewAuditEntry {
  actorId: number;
  actorRole: AuditActorRole;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: number;
  details?: string;
}

/** One inserted `audit_log` row, as returned by `record()`. */
export type AuditLogRow = typeof auditLog.$inferSelect;

/**
 * Inserts one audit row. Mirrors `AuditService.record`: the Java version
 * sets `actor` via `userRepository.getReferenceById(entry.actorId())` (a
 * lazy, unchecked reference) — here that becomes a plain `actor_id` column
 * value, with the same integrity guarantee enforced by the DB's
 * `fk_audit_log_actor` foreign key at insert time instead of by JPA. There
 * is no `@PrePersist`/default on `created_at` at the DB level (see
 * `V14__create_audit_log.sql`); Hibernate's `@CreationTimestamp` stamps it
 * in the Java entity, so this stamps it here the same way, right before the
 * insert.
 */
export async function record(entry: NewAuditEntry): Promise<AuditLogRow> {
  const [row] = await getDb()
    .insert(auditLog)
    .values({
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      details: entry.details ?? null,
      createdAt: new Date(),
    })
    .returning();
  return row;
}

/**
 * The minimal user shape the self-actored factories below need — id, role,
 * username — never the password hash. Deliberately not `features/users`'
 * `User`/`UserResponse` type: that slice doesn't exist yet in this phase
 * (it's the next task), and this module only needs these three fields.
 */
export interface AuditActorUser {
  id: number;
  role: UserRole;
  username: string;
}

/** Mirrors `NewAuditEntry.quoted` — wraps a name in literal double quotes for `details`. */
function quoted(name: string): string {
  return `"${name}"`;
}

/**
 * Mirrors `NewAuditEntry.self`: a self-actored entry where the acting user
 * is also the target (`targetType` USER, `targetId` = the user's own id).
 */
function self(user: AuditActorUser, action: AuditAction): NewAuditEntry {
  return {
    actorId: user.id,
    actorRole: user.role,
    action,
    targetType: "USER",
    targetId: user.id,
    details: quoted(user.username),
  };
}

/** Mirrors `NewAuditEntry.userRegistered`. */
export function userRegistered(user: AuditActorUser): NewAuditEntry {
  return self(user, "USER_REGISTERED");
}

/** Mirrors `NewAuditEntry.userLoggedIn`. */
export function userLoggedIn(user: AuditActorUser): NewAuditEntry {
  return self(user, "USER_LOGGED_IN");
}
