CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS curb_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blockface_key TEXT NOT NULL UNIQUE,
  borough TEXT,
  on_street TEXT,
  from_street TEXT,
  to_street TEXT,
  side_of_street TEXT,
  meter_rate TEXT,
  paid_hours TEXT,
  pay_by_cell TEXT,
  source TEXT NOT NULL,
  geom geometry(LineString, 4326) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS curb_segments_geom_gix ON curb_segments USING GIST (geom);

CREATE TABLE IF NOT EXISTS meter_blockfaces_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blockface_key TEXT NOT NULL UNIQUE,
  borough TEXT,
  on_street TEXT,
  from_street TEXT,
  to_street TEXT,
  side_of_street TEXT,
  meter_rate TEXT,
  paid_hours TEXT,
  pay_by_cell TEXT,
  payload JSONB NOT NULL,
  source_updated_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meter_blockfaces_raw_borough_idx ON meter_blockfaces_raw (borough);

CREATE TABLE IF NOT EXISTS parking_signs_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint TEXT NOT NULL UNIQUE,
  blockface_key TEXT NOT NULL,
  order_number TEXT,
  record_type TEXT,
  sign_code TEXT,
  sign_description TEXT,
  order_completed_on_date DATE,
  payload JSONB NOT NULL,
  source_updated_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS parking_signs_raw_blockface_idx ON parking_signs_raw (blockface_key);

CREATE TABLE IF NOT EXISTS curb_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curb_segment_id UUID NOT NULL REFERENCES curb_segments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('free', 'paid', 'no_parking', 'unknown')),
  day_mask INT NOT NULL CHECK (day_mask BETWEEN 0 AND 127),
  start_minute INT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INT NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'heuristic-v1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS curb_rules_segment_idx ON curb_rules (curb_segment_id);
CREATE INDEX IF NOT EXISTS curb_rules_status_idx ON curb_rules (status);
CREATE INDEX IF NOT EXISTS curb_rules_window_idx ON curb_rules (curb_segment_id, day_mask, start_minute, end_minute);
