INSERT INTO data_stewardship_decisions (
  decision_key, status, owner_agency, summary, metadata
) VALUES
(
  'parking-rule-catalog-v2',
  'pending',
  'NYC DOT',
  'The parking-rules-v2 interpretation catalog requires expert review before colored curb publication.',
  '{"safetyBehavior":"Return unknown even when geometry is approved until this interpretation version is approved."}'::jsonb
),
(
  'facility-directory-use',
  'pending',
  'NYC DCWP',
  'Use of the active Garage & Parking Lot license snapshot as a public facility directory requires steward approval.',
  '{"safetyBehavior":"Do not publish facility results until approved and fresh."}'::jsonb
),
(
  'official-city-identity',
  'pending',
  'NYC OTI',
  'Official City identity and production header require written brand and launch authorization.',
  '{"safetyBehavior":"Display prototype identity by default."}'::jsonb
)
ON CONFLICT (decision_key) DO NOTHING;
