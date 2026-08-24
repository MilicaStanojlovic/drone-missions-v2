-- Enforce the domain invariant that a mission always has a status.
-- The application already requires it (@NotNull on the request DTO), so no
-- existing row should hold a NULL status; this makes the guarantee schema-level.
ALTER TABLE mission ALTER COLUMN status SET NOT NULL;
