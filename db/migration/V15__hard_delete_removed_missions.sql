-- Admin removal becomes a real DELETE: REMOVED is no longer a state a mission can
-- sit in, so the rows parked there are deleted now (bids, notifications and
-- ratings cascade via their FKs) and the CHECK shrinks to the two live states.
-- The audit_log rows keep the history — their target is deliberately not an FK.
DELETE FROM mission WHERE moderation = 'REMOVED';

ALTER TABLE mission DROP CONSTRAINT mission_moderation_check;
ALTER TABLE mission ADD CONSTRAINT mission_moderation_check
    CHECK (moderation IN ('VISIBLE', 'HIDDEN'));
