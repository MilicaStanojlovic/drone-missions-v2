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
 * can be silently skipped is not one). This module ships the factories the
 * ported phases need — the two self-actored user ones from Phase 1
 * (`userRegistered`/`userLoggedIn`, where the acting user is also the
 * target), the three designer-actored mission ones from Phase 2
 * (`missionCreated`/`missionUpdated`/`missionDeleted`) and the two
 * pilot-actored bid ones from Phase 3 (`bidPlaced`/`bidWithdrawn`), the
 * four acceptance/lifecycle ones from Phase 5 (`bidAccepted` plus
 * `missionStarted`/`missionCompleted`/`missionCancelled`), the one
 * rating factory from Phase 6 (`ratingCreated`, the only one whose actor
 * role is *derived* rather than constant), and the admin-actored ones from
 * Phase 7 (`userSuspended`/`userReactivated` for user moderation,
 * `adminCreated` for minting another admin, plus
 * `missionHidden`/`missionUnhidden`/`missionRemoved` for mission moderation)
 * — each added by the phase that introduced the mutation it records.
 *
 * `AuditService.search` (the admin listing) is intentionally not ported here
 * — it belongs to the audit *read* path, which lands in Phase 7.
 *
 * SOURCE:
 * - drone-missions-backend/.../business/service/audit/AuditService.java (`record` only)
 * - drone-missions-backend/.../business/service/audit/NewAuditEntry.java (`userRegistered`, `userLoggedIn`, `missionCreated`, `missionUpdated`, `missionDeleted`, `missionStarted`, `missionCompleted`, `missionCancelled`, `missionHidden`, `missionUnhidden`, `missionRemoved`, `bidPlaced`, `bidWithdrawn`, `bidAccepted`, `ratingCreated`, `userSuspended`, `userReactivated`, `adminCreated`, `self`, `mission`, `quoted`)
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
 * The minimal user shape the user-targeted factories need — the id they target
 * and the username they snapshot into `details`. Structural, like
 * `AuditTargetMission`, so a loaded `User` satisfies it without audit (shared
 * core) importing the users feature — and never the password hash.
 */
export interface AuditTargetUser {
  id: number;
  username: string;
}

/**
 * A user acting on their own account, for the self-actored factories — the
 * target shape plus the role that becomes `actorRole`. Deliberately not
 * `features/users`' `User`/`UserResponse` type: this module only needs these
 * three fields.
 */
export interface AuditActorUser extends AuditTargetUser {
  role: UserRole;
}

/**
 * Mirrors `NewAuditEntry.quoted` — wraps a name in literal double quotes for
 * `details`.
 *
 * Accepts null because `mission.name` is a nullable column: Java's
 * `"\"%s\"".formatted(null)` renders the literal `"null"`, and template
 * interpolation renders exactly the same string here, so an unnamed mission
 * produces an identical audit row either way.
 */
function quoted(name: string | null): string {
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

/**
 * The minimal mission shape the mission factories below need — the id they
 * target and the name they snapshot into `details`. Structural, so a loaded
 * `Mission` satisfies it without this module importing the missions feature
 * (audit is shared core; features depend on it, never the reverse).
 */
export interface AuditTargetMission {
  id: number;
  name: string | null;
}

/**
 * Mirrors `NewAuditEntry.mission`: a mission-targeted entry whose `details`
 * snapshots the mission's name, so the row still says *what* was acted on
 * after the mission itself is deleted.
 *
 * The role is a constant per factory rather than the actor's actual role,
 * exactly as in the source — it restates the `@PreAuthorize` gate the action
 * already passed (here, `requireRole()` in the route layer).
 */
function missionEntry(
  actorId: number,
  actorRole: AuditActorRole,
  action: AuditAction,
  mission: AuditTargetMission,
): NewAuditEntry {
  return {
    actorId,
    actorRole,
    action,
    targetType: "MISSION",
    targetId: mission.id,
    details: quoted(mission.name),
  };
}

/** Mirrors `NewAuditEntry.missionCreated`. */
export function missionCreated(designerId: number, mission: AuditTargetMission): NewAuditEntry {
  return missionEntry(designerId, "DESIGNER", "MISSION_CREATED", mission);
}

/** Mirrors `NewAuditEntry.missionUpdated`. */
export function missionUpdated(designerId: number, mission: AuditTargetMission): NewAuditEntry {
  return missionEntry(designerId, "DESIGNER", "MISSION_UPDATED", mission);
}

/** Mirrors `NewAuditEntry.missionDeleted`. */
export function missionDeleted(designerId: number, mission: AuditTargetMission): NewAuditEntry {
  return missionEntry(designerId, "DESIGNER", "MISSION_DELETED", mission);
}

/**
 * Mirrors `NewAuditEntry.missionCancelled` — designer-actored, like the other
 * three mission factories the owning designer triggers.
 *
 * One row per *intent*, not per side effect: `MissionService.cancel` also
 * rejects the mission's PENDING/ACCEPTED bids, and none of that is audited —
 * exactly as `AuditAction`'s own javadoc spells out ("cancelling a mission
 * rejects its bids, but only MISSION_CANCELLED is recorded").
 */
export function missionCancelled(designerId: number, mission: AuditTargetMission): NewAuditEntry {
  return missionEntry(designerId, "DESIGNER", "MISSION_CANCELLED", mission);
}

/**
 * Mirrors `NewAuditEntry.missionStarted` — PILOT, not DESIGNER: the awarded
 * pilot is the one who starts the mission, and the constant role restates that
 * gate the same way the designer factories restate theirs.
 */
export function missionStarted(pilotId: number, mission: AuditTargetMission): NewAuditEntry {
  return missionEntry(pilotId, "PILOT", "MISSION_STARTED", mission);
}

/** Mirrors `NewAuditEntry.missionCompleted` — pilot-actored, like `missionStarted`. */
export function missionCompleted(pilotId: number, mission: AuditTargetMission): NewAuditEntry {
  return missionEntry(pilotId, "PILOT", "MISSION_COMPLETED", mission);
}

/**
 * Mirrors `NewAuditEntry.missionHidden` — ADMIN-actored: moderation is an
 * admin action on someone else's mission, so unlike the four designer factories
 * above, the actor is never the mission's owner.
 *
 * `MissionService.hide` records this only after the VISIBLE -> HIDDEN
 * transition actually lands, so a rejected transition (already hidden) leaves
 * no row — one row means one state change, the same rule
 * `userSuspended` follows.
 */
export function missionHidden(adminId: number, mission: AuditTargetMission): NewAuditEntry {
  return missionEntry(adminId, "ADMIN", "MISSION_HIDDEN", mission);
}

/** Mirrors `NewAuditEntry.missionUnhidden` — the mirror image, HIDDEN -> VISIBLE. */
export function missionUnhidden(adminId: number, mission: AuditTargetMission): NewAuditEntry {
  return missionEntry(adminId, "ADMIN", "MISSION_UNHIDDEN", mission);
}

/**
 * Mirrors `NewAuditEntry.missionRemoved` — admin removal, which per
 * `MissionService.remove`'s javadoc is a *real* delete: the mission's bids,
 * notifications and ratings cascade away with it and only this row keeps the
 * history. That is why the entry is built from the mission loaded before the
 * delete — `details` is the last surviving record of what was removed.
 *
 * Distinct from `missionDeleted` (DESIGNER, the owner deleting their own): the
 * two actions differ in who may do it, so the source gives them separate
 * `AuditAction` values rather than one delete event with two actors.
 */
export function missionRemoved(adminId: number, mission: AuditTargetMission): NewAuditEntry {
  return missionEntry(adminId, "ADMIN", "MISSION_REMOVED", mission);
}

/**
 * The minimal bid shape the two bid factories need — the id they target, the
 * amount they snapshot, and the mission whose name goes into `details`. The
 * Java factories read exactly these off the entity (`bid.getId()`,
 * `bid.getAmount()`, `bid.getMission().getName()`).
 *
 * Structural like `AuditTargetMission`, so a loaded `Bid` from
 * `features/bids` satisfies it without audit (shared core) importing the bids
 * feature. Only the mission's `name` is required — the nested shape reuses
 * `AuditTargetMission` so the two never drift apart.
 */
export interface AuditTargetBid {
  id: number;
  amount: number;
  mission: Pick<AuditTargetMission, "name">;
}

/**
 * Mirrors `NewAuditEntry.bidPlaced` — details are
 * `"{amount} on \"{missionName}\"{ (updated)}"`.
 *
 * `updated` distinguishes the two halves of `place()`'s upsert, exactly as the
 * source's comment says: "place() upserts, and 'raised an existing bid' is
 * worth telling apart". It is a required parameter here rather than a
 * defaulted one, matching the Java signature — every call site already knows
 * which branch it took.
 *
 * KNOWN DIVERGENCE (rendering only, inherited from `Bid.amount` being a
 * `number`): Java formats a `BigDecimal`, which carries the column's scale, so
 * a bid loaded from `numeric(12, 2)` renders `"1500.00"`. A JS number has no
 * scale, so the same bid renders `"1500"` — while `1500.5` renders `"1500.5"`
 * where Java would say `"1500.50"`. `details` is a human-readable snapshot
 * that nothing parses, and the alternative (re-introducing the decimal text
 * into the domain type) would undo the narrowing `bid.types.ts` deliberately
 * makes. Noted rather than papered over with a `toFixed(2)`, which would
 * diverge from `NewAuditEntryTest`'s `BigDecimal.TEN` expectation of `"10"`.
 */
export function bidPlaced(pilotId: number, bid: AuditTargetBid, updated: boolean): NewAuditEntry {
  return {
    actorId: pilotId,
    actorRole: "PILOT",
    action: "BID_PLACED",
    targetType: "BID",
    targetId: bid.id,
    details: `${bid.amount} on ${quoted(bid.mission.name)}${updated ? " (updated)" : ""}`,
  };
}

/**
 * Mirrors `NewAuditEntry.bidWithdrawn` — the same `details` snapshot as
 * `bidPlaced` without the suffix. Snapshotting amount and mission name matters
 * most here: `withdraw()` deletes the row, so this entry is all that is left
 * of the bid.
 */
export function bidWithdrawn(pilotId: number, bid: AuditTargetBid): NewAuditEntry {
  return {
    actorId: pilotId,
    actorRole: "PILOT",
    action: "BID_WITHDRAWN",
    targetType: "BID",
    targetId: bid.id,
    details: `${bid.amount} on ${quoted(bid.mission.name)}`,
  };
}

/**
 * Mirrors `NewAuditEntry.bidAccepted` — the same `"{amount} on
 * \"{missionName}\""` snapshot as `bidWithdrawn`, but DESIGNER-actored: the
 * mission's designer decides, so the actor is the designer while the target
 * stays the pilot's bid.
 *
 * One row per intent again: `BidService.accept` also rejects every other
 * pending bid on the mission, and those rejections are not audited (they are a
 * side effect of this one decision, per `AuditAction`'s javadoc).
 *
 * The `bidPlaced` note on `BigDecimal`-vs-`number` rendering applies verbatim
 * to this factory's `details` too.
 */
export function bidAccepted(designerId: number, bid: AuditTargetBid): NewAuditEntry {
  return {
    actorId: designerId,
    actorRole: "DESIGNER",
    action: "BID_ACCEPTED",
    targetType: "BID",
    targetId: bid.id,
    details: `${bid.amount} on ${quoted(bid.mission.name)}`,
  };
}

/**
 * The mission shape `ratingCreated` needs. Unlike `AuditTargetMission` it is
 * not the *target* of the entry (the rating is) — it supplies the name that
 * goes into `details` and the designer id the actor role is derived from.
 *
 * `userId` is the `designer` relation's FK column, i.e. the port of
 * `mission.getDesignerId()`; it is nullable for the same reason the Java getter
 * is null-tolerant — an ownerless legacy mission has no designer. Reusing
 * `AuditTargetMission["name"]` keeps the two mission shapes from drifting, the
 * same way `AuditTargetBid` reuses it.
 */
export interface AuditRatingMission extends Pick<AuditTargetMission, "name"> {
  /** The owning designer's id — `mission.user_id`, null on legacy rows. */
  userId: number | null;
}

/**
 * The saved rating an entry targets — the id it points at and the score it
 * snapshots. The Java factory reads exactly these two off the entity
 * (`rating.getId()`, `rating.getScore()`), so a loaded `Rating` from
 * `features/ratings` satisfies this structurally without audit (shared core)
 * importing the ratings feature.
 */
export interface AuditTargetRating {
  id: number;
  score: number;
}

/**
 * Mirrors `NewAuditEntry.ratingCreated` — details are
 * `"{score}/5 on \"{missionName}\""`.
 *
 * The **only** factory here whose `actorRole` is derived rather than constant,
 * and deliberately so: the other actions are each gated to one role, but both
 * sides of a completed mission may rate, so the role has to say *which* side
 * this rater was. The source's rule is reproduced exactly — the rater is the
 * DESIGNER if they own the mission and the PILOT otherwise, with no third
 * possibility, because `RatingService.counterpartOf` has already rejected
 * anyone who is neither (`NotMissionParticipantError`).
 *
 * A null `mission.userId` therefore yields PILOT, matching Java's
 * `raterId.equals(null)` returning false rather than throwing.
 *
 * Called after the insert, never before: `targetId` is the identity id the
 * database assigns, so the entry can only be built from the *saved* row.
 */
export function ratingCreated(
  raterId: number,
  mission: AuditRatingMission,
  rating: AuditTargetRating,
): NewAuditEntry {
  return {
    actorId: raterId,
    actorRole: raterId === mission.userId ? "DESIGNER" : "PILOT",
    action: "RATING_CREATED",
    targetType: "RATING",
    targetId: rating.id,
    details: `${rating.score}/5 on ${quoted(mission.name)}`,
  };
}

/**
 * An admin-actored, user-targeted entry: `details` snapshots the *target's*
 * username, while the actor is the admin who acted.
 *
 * The Java factories build these two inline rather than through a shared
 * helper, but they differ only in their `AuditAction`; one helper here follows
 * this file's own `missionEntry` precedent and keeps the pair from drifting.
 * Like every other factory, the role is the constant ADMIN rather than the
 * actor's looked-up role — it restates the `@PreAuthorize("hasRole('ADMIN')")`
 * gate the action already passed (here, `requireRole()` in the route layer).
 */
function adminUserEntry(
  adminId: number,
  action: AuditAction,
  target: AuditTargetUser,
): NewAuditEntry {
  return {
    actorId: adminId,
    actorRole: "ADMIN",
    action,
    targetType: "USER",
    targetId: target.id,
    details: quoted(target.username),
  };
}

/**
 * Mirrors `NewAuditEntry.userSuspended`. Unlike `userRegistered`/`userLoggedIn`,
 * actor and target are different accounts — the row answers "which admin
 * suspended whom", which is the whole point of auditing moderation.
 *
 * `UserService.suspend` only records this when the account was not already
 * suspended, so one row means one state change, not one button press.
 */
export function userSuspended(adminId: number, target: AuditTargetUser): NewAuditEntry {
  return adminUserEntry(adminId, "USER_SUSPENDED", target);
}

/** Mirrors `NewAuditEntry.userReactivated` — the lifting of a suspension, same shape. */
export function userReactivated(adminId: number, target: AuditTargetUser): NewAuditEntry {
  return adminUserEntry(adminId, "USER_REACTIVATED", target);
}

/**
 * Mirrors `NewAuditEntry.adminCreated` — the row written when one admin mints
 * another through `POST /api/v1/users/admins`.
 *
 * The actor is the **creating admin**, not the new account, which is exactly
 * what the source's own comment flags as the difference from self-actored
 * registration: `userRegistered` records the new user as its own actor, while
 * this records who let them in. The pair is otherwise identical in shape
 * (targetType USER, `details` = the new admin's quoted username), so both rows
 * still name the account created even after it is gone.
 *
 * It shares `adminUserEntry` with the two moderation factories for the same
 * reason they share it — admin actor, user target, quoted-username details —
 * and, like them, hardcodes the ADMIN role rather than looking the actor's up:
 * a constant that restates the `@PreAuthorize("hasRole('ADMIN')")` the request
 * already cleared.
 */
export function adminCreated(adminId: number, newAdmin: AuditTargetUser): NewAuditEntry {
  return adminUserEntry(adminId, "ADMIN_CREATED", newAdmin);
}
