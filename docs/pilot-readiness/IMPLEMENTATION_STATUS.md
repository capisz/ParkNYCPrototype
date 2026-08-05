# Citywide public-pilot implementation status

Updated: 2026-07-19

This repository now implements the safety foundation of the public-pilot plan. It does not assert that institutional, data, field, security, accessibility, translation, transit, or operational release gates have passed.

| Workstream | Repository status | Release status |
|---|---|---|
| Anonymous destination-first flow | Implemented on web and iOS; arrival and leave times are required | Requires usability and five-borough validation |
| Versioned API contract | `/api/v1/plans`, curb viewport, facilities, data status, liveness/readiness, and OpenAPI implemented | Schema compatibility checks and formal API review remain |
| Parking status contract | `cannot_park`, `paid`, `free`, `unknown`; gray/red excluded from recommendations | DOT golden corpus and field audit remain mandatory |
| Snapshot ingestion | Atomic signs, meters, geometry-context, and facilities snapshots with run IDs, checksums, deletion, failure isolation, and rollback-by-active-version | Restore drills, upstream alerts, and production scheduler remain |
| Curb geometry | Unsafe Street Pavement Ratings geometry is marked unapproved. A bounded, non-recommendable pilot layer may show fresh, side-specific ParkNYC meter blockfaces yellow for full-interval paid evidence, red for a fresh supported high-confidence prohibition, or green as a public-data estimate only when fresh linked sign records and a recognized meter schedule completely resolve the interval. Unresolved regulatory signs remain gray. | DOT-approved curb geometry and sign-side linkage remain required for recommendation eligibility and release; reference green must pass the field-audit gate before any authority claim |
| Rule interpretation | Versioned fail-closed parser rejects unsupported/ambiguous categories; reviewed 2026 DOT ASP/Sunday/major-holiday context is applied only to explicitly tagged rules | Expert catalog, live 311 emergency suspensions, school/temporary/event rules, physical exclusions, and 1,000-example corpus remain |
| Licensed facilities | Staged DCWP active Garage & Parking Lot directory; no price/capacity/availability claims | Current source metadata is outside the 14-day gate, so publication remains unavailable until DCWP freshness is acceptable |
| Transit | Feature flag, capability status, origin requirement, and honest disabled response implemented | OTP deployment, MTA credentials/agreements, realtime, return routing, accessibility, and 200-scenario corpus remain |
| Web accessibility and rendering | Semantic forms, keyboard suggestions, text legend, non-color labels, automated axe gate, and desktop/mobile canvas-pixel checks for red/yellow/green/gray plus selected-curb artifacts | Manual keyboard, screen reader, zoom, motion, map alternative, translation, and RTL review remain |
| iOS | Anonymous v1 client, iOS 17 target, explicit location permission, no auth/camera/sign scanner, active-license facilities | Simulator runtime is blocked on this host; real-device VoiceOver/Switch Control and contract tests remain |
| Security/operations | Minimal liveness, protected readiness, rate limit, headers, request IDs, redacted path-only logs, rollback-safe feature flags | OTI review, ASVS L2, threat model, pentest, WAF/CDN, managed secrets, observability, backups, on-call, and status page remain |
| Privacy | No accounts or trip history; request logs exclude queries and coordinates; public privacy/terms/source pages added | City privacy/analytics approval and production retention verification remain |
| Language access | No misleading automated translation claim; English is explicit | Nine additional professionally translated languages and RTL QA remain |

## Public-release hold

Citywide publication stays blocked until every item in `RELEASE_GATES.md` is signed. Production feature flags default off. Dataset-specific failures can make curbs gray or disable facilities/transit without deploying client changes.
