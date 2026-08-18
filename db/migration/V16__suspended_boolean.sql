-- Suspension becomes a plain flag. The when-suspended timestamp is not lost:
-- every suspension writes a USER_SUSPENDED audit_log row with its own created_at.
ALTER TABLE users ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET suspended = (suspended_at IS NOT NULL);
ALTER TABLE users DROP COLUMN suspended_at;
