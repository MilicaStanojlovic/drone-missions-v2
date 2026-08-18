-- Mission descriptions are full mission briefs, not one-liners; VARCHAR(255) was
-- too tight and truncation/overflow surfaced in the UI. Widen to VARCHAR(2000).
-- Increasing a varchar length in PostgreSQL is a metadata-only change: no table
-- rewrite, no data loss.
ALTER TABLE mission ALTER COLUMN description TYPE VARCHAR(2000);
