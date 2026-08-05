# Public-pilot risk register

| Risk | Severity | Current control | Exit condition |
|---|---:|---|---|
| Wrong-side or centerline curb display | Critical | Pavement centerlines excluded from viewport; meter blockfaces require an unambiguous side, are reference-only, and remain non-recommendable; no hydrant curb extrapolation | DOT-approved side/extent linkage and zero wrong-side failures in field corpus |
| False green classification | Critical | Full-interval evidence required; a synthetic free baseline is published only for fresh meter blockfaces with at least one linked regulatory sign, a recognized meter schedule, and no unresolved regulatory sign; all reference green remains non-recommendable | 1,000-example golden corpus and 500-blockface audit with no false green |
| Stale/deleted source rows | Critical | Atomic snapshots, checksums, source timestamps, deletion of absent records, prior-version preservation | Scheduled ingestion monitoring and rollback/restore drill |
| Non-garage businesses in facility results | High | Exact DCWP category/status query, staged validation, active-license table | Complete active-set validation by DCWP |
| Facility source outside freshness window | High | API returns unavailable after 14 days | Fresh DCWP source metadata or steward-approved alternative cadence |
| Fake or stale transit routing | Critical | Transit disabled by default; no static proximity routing | OTP/MTA architecture, realtime lag warnings, alerts, return-trip and accessibility corpus |
| False accessible-route claim | Critical | No accessible-route claims while transit is gated | Complete step-free path evaluation plus current outage feed and stale-feed fallback |
| Color-only or inaccessible map | High | Text labels, gray state, non-color status text, axe checks | Manual WCAG 2.2 AA, screen-reader, zoom, keyboard, motion, and map-alternative sign-off |
| Impersonating an official service before approval | High | Prototype header by default; official wording environment-gated | Written NYC brand and launch authorization |
| Sensitive trip data in telemetry | High | Anonymous clients; no query strings/coordinates in API logs; no trip history | Production telemetry/retention audit and OTI privacy approval |
| Credential, dependency, or deployment compromise | High | Server-only tokens, security headers, rate limits, CI builds/tests | Secrets manager, ASVS L2, SBOM/signing, scans, pentest, WAF and OTI approval |
| Unrecoverable production outage/data loss | High | Atomic data versions and safe failed ingests | Managed encrypted backups, successful restore test, runbooks, on-call, rollback deployment |
| Inadequate language access | High | English clearly identified; no false translation control | Professional translation in ten required languages and RTL/plain-language QA |
