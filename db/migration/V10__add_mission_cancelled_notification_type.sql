-- Widen the notification type CHECK to allow MISSION_CANCELLED (designer cancelled a won mission).
-- Postgres CHECK constraints can't be altered in place, so drop and re-add.
ALTER TABLE notification DROP CONSTRAINT notification_type_check;
ALTER TABLE notification ADD CONSTRAINT notification_type_check
    CHECK (type IN ('BID_ACCEPTED', 'BID_REJECTED', 'MISSION_OVERDUE', 'MISSION_CANCELLED'));
