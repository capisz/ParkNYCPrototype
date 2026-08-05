# Release gates

No single automated test or stakeholder can waive another gate. Evidence links and named approvals must be attached to the release record.

## Data and recommendations

- [ ] DOT approves curb/blockface geometry and sign-side linkage.
- [ ] DOT approves a versioned catalog and at least 1,000 golden sign/rule examples, including DST, holidays, suspensions, overnight rules, arrows, side, temporary restrictions, and unsupported evidence.
- [ ] Five-borough field audit covers at least 500 blockfaces, 100 per borough, with zero false green, wrong-side geometry, or unsupported colored classification.
- [ ] Any failure is corrected and followed by 100 additional samples from the affected category.
- [ ] Complete facility snapshot contains only active Garage & Parking Lot licenses; expired/deleted rows disappear after publication.
- [ ] All source freshness and dataset kill-switch drills pass.

## Transit

- [ ] MTA feed, redistribution, trademark, map, and symbol agreements are complete.
- [ ] OTP routes official schedules and OSM streets in isolated City infrastructure.
- [ ] GTFS-Realtime lag above one minute is visibly warned and never labeled live.
- [ ] 200 round-trip scenarios pass all modes, boroughs, nights, weekends, transfers, alerts, and return-to-car parking intervals.
- [ ] At least 50 accessibility/outage scenarios have no false step-free claim.

## Accessibility, language, privacy, and security

- [x] Automated axe and rendered desktop/mobile visual regression pass: four journeys assert the legend and totals, inspect map-canvas pixels for red/yellow/green/gray, exercise a selected curb, and capture desktop/mobile artifacts in CI.
- [ ] Keyboard, VoiceOver, Switch Control, 200%/400% zoom, contrast, motion, and map-alternative review pass.
- [ ] English, Arabic, Bengali, Chinese, French, Haitian Creole, Korean, Polish, Russian, Spanish, and Urdu receive professional translation, plain-language review, and RTL QA where applicable.
- [ ] Privacy, accessibility, terms, data sources, retention, advisory, and analytics notices receive City approval.
- [ ] Threat model, OWASP ASVS Level 2 review, dependency/container/secret scans, SBOM, artifact signing, pentest, and OTI approval pass.

## Operations and launch

- [ ] Development, staging, and production are isolated and reproducible.
- [ ] Managed Postgres/PostGIS backup restoration succeeds.
- [ ] Metrics, traces, redacted logs, data dashboards, alerts, runbooks, on-call, and public status page are operational.
- [ ] Performance passes at 10x forecast pilot peak: viewport p95 <750 ms, search <500 ms, multimodal plan <2.5 s.
- [ ] Staging is stable for 30 days.
- [ ] Employee alpha runs for two weeks; invite-only five-borough validation runs for four weeks.
- [ ] Web/iOS contract parity and real-device iOS testing pass.
- [ ] DOT data and product approval, OTI security/privacy/accessibility approval, DCWP facility-data approval, and MTA agreements are signed.
