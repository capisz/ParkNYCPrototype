CREATE TABLE IF NOT EXISTS ingestion_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_key TEXT NOT NULL,
  source_dataset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'published', 'failed', 'superseded')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  row_count INT,
  checksum TEXT,
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ingestion_runs_dataset_published_idx
  ON ingestion_runs (dataset_key, published_at DESC)
  WHERE status = 'published';

ALTER TABLE curb_segments
  ADD COLUMN IF NOT EXISTS source_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS geometry_validated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS interpretation_version TEXT NOT NULL DEFAULT 'parking-rules-v1';

ALTER TABLE meter_blockfaces_raw
  ADD COLUMN IF NOT EXISTS source_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL;

ALTER TABLE parking_signs_raw
  ADD COLUMN IF NOT EXISTS source_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL;

ALTER TABLE street_geometry_raw
  ADD COLUMN IF NOT EXISTS source_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS curb_segments_source_run_idx ON curb_segments (source_run_id);
CREATE INDEX IF NOT EXISTS meter_blockfaces_raw_source_run_idx ON meter_blockfaces_raw (source_run_id);
CREATE INDEX IF NOT EXISTS parking_signs_raw_source_run_idx ON parking_signs_raw (source_run_id);
CREATE INDEX IF NOT EXISTS street_geometry_raw_source_run_idx ON street_geometry_raw (source_run_id);

CREATE TABLE IF NOT EXISTS data_stewardship_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  owner_agency TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_url TEXT,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO data_stewardship_decisions (
  decision_key, status, owner_agency, summary, metadata
) VALUES (
  'curb-geometry-authority',
  'pending',
  'NYC DOT',
  'Street Pavement Ratings centerlines are not approved as curb-side geometry.',
  '{"safetyBehavior":"Return unknown until an approved blockface geometry and side linkage is recorded."}'::jsonb
) ON CONFLICT (decision_key) DO NOTHING;
