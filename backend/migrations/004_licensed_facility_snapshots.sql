CREATE TABLE IF NOT EXISTS licensed_facilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_number TEXT NOT NULL UNIQUE,
  legal_name TEXT NOT NULL,
  dba_name TEXT,
  address TEXT NOT NULL,
  phone TEXT,
  license_status TEXT NOT NULL CHECK (license_status = 'Active'),
  license_expires_at DATE,
  facility_details TEXT,
  geom geometry(Point, 4326) NOT NULL,
  payload JSONB NOT NULL,
  source_run_id UUID NOT NULL REFERENCES ingestion_runs(id) ON DELETE RESTRICT,
  source_updated_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS licensed_facilities_geom_gix
  ON licensed_facilities USING GIST (geom);

CREATE INDEX IF NOT EXISTS licensed_facilities_source_run_idx
  ON licensed_facilities (source_run_id);
