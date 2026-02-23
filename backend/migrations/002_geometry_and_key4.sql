CREATE OR REPLACE FUNCTION blockface_key4(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    split_part(COALESCE(input, ''), '|', 1) || '|' ||
    split_part(COALESCE(input, ''), '|', 2) || '|' ||
    split_part(COALESCE(input, ''), '|', 3) || '|' ||
    split_part(COALESCE(input, ''), '|', 4)
$$;

CREATE INDEX IF NOT EXISTS curb_segments_blockface_key4_idx
  ON curb_segments (blockface_key4(blockface_key));

CREATE INDEX IF NOT EXISTS meter_blockfaces_raw_blockface_key4_idx
  ON meter_blockfaces_raw (blockface_key4(blockface_key));

CREATE INDEX IF NOT EXISTS parking_signs_raw_blockface_key4_idx
  ON parking_signs_raw (blockface_key4(blockface_key));

CREATE TABLE IF NOT EXISTS street_geometry_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  geometry_key TEXT NOT NULL UNIQUE,
  blockface_key TEXT NOT NULL,
  borough TEXT,
  on_street TEXT,
  from_street TEXT,
  to_street TEXT,
  source_updated_at DATE,
  payload JSONB NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS street_geometry_raw_blockface_idx
  ON street_geometry_raw (blockface_key);
