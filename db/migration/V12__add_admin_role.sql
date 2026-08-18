-- Widen the role CHECK to allow ADMIN (drop and re-add, as in V10), then seed the
-- first admin account. Registration rejects ADMIN, so seeding is the only way one
-- can exist; the BCrypt hash is a dev credential — rotate it for any real deployment.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('DESIGNER', 'PILOT', 'ADMIN'));


