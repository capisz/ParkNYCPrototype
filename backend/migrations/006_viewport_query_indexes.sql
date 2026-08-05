-- The public map only serves DOT-validated curb geometry or the deliberately
-- bounded official meter-blockface reference geometry. Keeping a partial GiST
-- index for that small displayable subset prevents pavement centerlines from
-- dominating every viewport scan.
CREATE INDEX IF NOT EXISTS curb_segments_reference_geom_gix
  ON curb_segments USING GIST (geom)
  WHERE geometry_validated OR source LIKE 'meters:%';

-- Readiness/freshness checks select the newest run for each dataset on every
-- short cache refresh. This supports that ordered lookup as run history grows.
CREATE INDEX IF NOT EXISTS ingestion_runs_dataset_started_idx
  ON ingestion_runs (dataset_key, started_at DESC);
