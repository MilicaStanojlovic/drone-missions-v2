-- Mission ownership: each mission is created by (and belongs to) one user.
-- Nullable because missions created before authentication existed have no owner;
-- those legacy rows stay editable by nobody. New missions always set user_id.
ALTER TABLE mission ADD COLUMN user_id BIGINT;
ALTER TABLE mission ADD CONSTRAINT fk_mission_user
    FOREIGN KEY (user_id) REFERENCES users (id);
