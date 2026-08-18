-- Moderation state for the admin milestone: users can be suspended (reversibly),
-- missions can be hidden from the feed or removed from the platform (both reversible).
-- Mission moderation is a separate column, not new status values, so hiding never
-- disturbs the lifecycle status and restoring needs no state reconstruction.
ALTER TABLE users ADD COLUMN suspended_at TIMESTAMP(6) WITH TIME ZONE;

ALTER TABLE mission ADD COLUMN moderation VARCHAR(16) NOT NULL DEFAULT 'VISIBLE';
ALTER TABLE mission ADD CONSTRAINT mission_moderation_check
    CHECK (moderation IN ('VISIBLE', 'HIDDEN', 'REMOVED'));
