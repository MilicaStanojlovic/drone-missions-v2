-- Each account is exactly one of DESIGNER (lists work) or PILOT (flies it).
-- Mirrors the entity enum com.project.drone_missions.data.model.UserRole, stored as
-- its name via @Enumerated(EnumType.STRING).
--
-- Existing rows are backfilled to DESIGNER: before roles existed every account could
-- create missions, which is exactly what a DESIGNER does, so this preserves what
-- current users are already able to do. The column is added nullable, backfilled, then
-- made NOT NULL, so the migration works on a table that already has rows.
ALTER TABLE users ADD COLUMN role VARCHAR(32);

UPDATE users SET role = 'DESIGNER' WHERE role IS NULL;

ALTER TABLE users ALTER COLUMN role SET NOT NULL;

ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('DESIGNER', 'PILOT'));
