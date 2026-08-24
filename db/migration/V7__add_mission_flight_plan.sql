-- Flight-plan data for a mission: where it is, when bids close, and the route +
-- flight zone the pilot will fly. Waypoints and the geofence are variable-shape
-- structures (an ordered list of points; a circle OR a polygon), so they are stored
-- as JSONB rather than modelled relationally. All columns are nullable — drafts and
-- pre-existing rows simply have no plan yet, so no backfill is needed.
--
-- Coordinates are geographic WGS84 lat/lng (degrees); circle radius is in metres.
ALTER TABLE mission ADD COLUMN location         VARCHAR(255);
ALTER TABLE mission ADD COLUMN bidding_deadline DATE;
ALTER TABLE mission ADD COLUMN waypoints        JSONB;
ALTER TABLE mission ADD COLUMN geofence         JSONB;
