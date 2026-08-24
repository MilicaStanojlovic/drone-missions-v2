-- MISSION_RESTORED is retired: restore no longer exists (removal is a hard
-- delete since V15). Purge historical rows so the enum can drop the value,
-- then tighten the CHECK by drop-and-re-add, as in V17.
DELETE FROM audit_log WHERE action = 'MISSION_RESTORED';
ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN (
    'MISSION_CREATED', 'MISSION_UPDATED', 'MISSION_DELETED', 'MISSION_STARTED',
    'MISSION_COMPLETED', 'MISSION_CANCELLED', 'MISSION_HIDDEN', 'MISSION_UNHIDDEN',
    'MISSION_REMOVED',
    'BID_PLACED', 'BID_WITHDRAWN', 'BID_ACCEPTED',
    'USER_REGISTERED', 'USER_LOGGED_IN', 'USER_SUSPENDED', 'USER_REACTIVATED',
    'ADMIN_CREATED',
    'RATING_CREATED'));
