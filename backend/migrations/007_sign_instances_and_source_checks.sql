ALTER TABLE ingestion_runs
  ADD COLUMN IF NOT EXISTS source_checked_at TIMESTAMPTZ;

UPDATE ingestion_runs
SET source_checked_at = COALESCE(completed_at, published_at, started_at)
WHERE source_checked_at IS NULL;

ALTER TABLE parking_signs_raw
  ADD COLUMN IF NOT EXISTS order_type TEXT,
  ADD COLUMN IF NOT EXISTS sign_location TEXT,
  ADD COLUMN IF NOT EXISTS distance_from_intersection DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS arrow_direction TEXT,
  ADD COLUMN IF NOT EXISTS facing_direction TEXT,
  ADD COLUMN IF NOT EXISTS sign_x_coord DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sign_y_coord DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);

CREATE INDEX IF NOT EXISTS parking_signs_raw_geom_gix
  ON parking_signs_raw USING GIST (geom);

CREATE INDEX IF NOT EXISTS parking_signs_raw_source_position_idx
  ON parking_signs_raw (source_run_id, blockface_key, distance_from_intersection);
