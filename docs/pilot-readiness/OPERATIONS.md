# Operations baseline

## Service objectives

- Monthly availability target: 99.9% after production approval.
- Performance gates: viewport p95 under 750 ms, destination search under 500 ms, and full multimodal plans under 2.5 seconds at 10x forecast pilot peak.
- Public `/livez` contains only service liveness. `/readyz` requires `Authorization: Bearer <OPERATIONS_TOKEN>` and exposes database, migration, feature, and ingestion state.

## Feature and dataset controls

- `ENABLE_CURB_GUIDANCE`: closes the public curb endpoint and direct-curb planning.
- `ENABLE_GARAGES`: closes the facility directory and removes facilities from plans.
- `ENABLE_TRANSIT`: exposes transit capability only; candidate publication remains code-gated until validation.
- Data freshness automatically turns unresolved curb classifications gray or returns facility data unavailable.
- `TRUST_METER_GEOMETRY` remains false unless a recorded DOT decision authorizes it.

## Ingestion incident response

1. Do not publish a failed or partial source snapshot.
2. Confirm the last published run remains active in protected readiness.
3. Close the affected feature flag if freshness or validation cannot be trusted.
4. Record source metadata, schema change, affected versions, and user impact.
5. Correct the importer in staging, run deletion/schema/quality tests, and publish a new version.
6. Reopen only after the data steward accepts the validation report.

## Privacy and logging

Request logs include request ID, method, path without query, status, and duration. They exclude request bodies, search text, coordinates, origins, destinations, authorization headers, and query strings. Production analytics must be aggregate and City-approved. No account or trip-history store is part of the pilot.

## Required production capabilities

The repository does not substitute for managed infrastructure. Production still needs encrypted backups and restore testing, a secrets manager, CDN/WAF, distributed rate controls, metrics/traces, data-quality dashboards, paging, an on-call rotation, incident communications, artifact signing, rollback deployments, and a public service-status page.
