-- Widen the role CHECK to allow ADMIN (drop and re-add, as in V10). Registration
-- rejects ADMIN, so an admin can only come into being out of band: create the row
-- directly, then set its password with scripts/set-admin-password.mjs (which hashes
-- a value you supply). No admin is seeded here — a committed password hash is a
-- credential, and this migration is public, so the seed that used to live in this
-- file was removed and purged from history.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('DESIGNER', 'PILOT', 'ADMIN'));
