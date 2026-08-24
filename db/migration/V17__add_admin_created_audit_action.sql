-- Admins can now register other admins; the action gets its own audit value.
-- Widen the CHECK by drop-and-re-add, as in V12.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN (
    'MISSION_CREATED', 'MISSION_UPDATED', 'MISSION_DELETED', 'MISSION_STARTED',
    'MISSION_COMPLETED', 'MISSION_CANCELLED', 'MISSION_HIDDEN', 'MISSION_UNHIDDEN',
    'MISSION_REMOVED', 'MISSION_RESTORED',
    'BID_PLACED', 'BID_WITHDRAWN', 'BID_ACCEPTED',
    'USER_REGISTERED', 'USER_LOGGED_IN', 'USER_SUSPENDED', 'USER_REACTIVATED',
    'ADMIN_CREATED',
    'RATING_CREATED'));
