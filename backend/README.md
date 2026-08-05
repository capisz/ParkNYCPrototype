# NYC Parking Planner API

The backend is the sole parking-rule authority for the web and iOS clients. It publishes interval-aware advisory results from atomic source snapshots and fails closed when evidence, freshness, interpretation, or curb geometry is unresolved.

## Public contract

- `POST /api/v1/plans`
- `GET /api/v1/search` and `GET /api/v1/search/autocomplete`
- `GET /api/v1/curb/viewport?minLat&minLng&maxLat&maxLng&start&end&detail=map`
- `GET /api/v1/curb/:segmentId?start&end` (full evidence for one selected feature)
- `GET /api/v1/facilities?lat&lng&radius`
- `GET /api/v1/data-status`
- `GET /openapi.json`
- `GET /livez` (minimal public liveness)
- `GET /readyz` (Bearer-token protected operational readiness)

`ParkingStatus` is `cannot_park | paid | free | unknown`. Unknown or prohibited curbs are not eligible recommendations. `free` means likely legally free for the complete requested interval, not that a physical space is vacant. It requires current linked sign evidence, a fully recognized schedule, and no active payment or recognized restriction; missing evidence is never treated as permission.

Interactive maps should request `detail=map`; the compact response omits evidence and version arrays that MapLibre does not need. Selecting a feature fetches its full detail by ID. Viewport work is capped by zoom, geometry is clipped and generalized to sub-meter/map-scale precision, identical proximity requests coalesce in a 20-second process cache, and responses permit a short private browser cache. The API emits `Server-Timing`, while structured service logs split freshness, PostGIS, and classification time. The PostGIS query never publishes pavement-centerline context: it scans only approved geometry or the active official meter-blockface reference snapshot.

Destination search normally proxies the configured NYC geocoder. A small reviewed degraded-mode directory resolves only explicit landmark aliases and labeled neighborhood centers when an exact curated match is entered, avoiding an upstream wait without pretending to geocode arbitrary addresses.

## Environment

Copy `.env.example` to `.env`, set `DATABASE_URL`, and use a unique `OPERATIONS_TOKEN`. Production also requires a City-managed `NYC_APP_TOKEN`. Feature flags default closed in production.

```sh
npm install
npm run migrate
npm run ingest:all
npm run dev
```

Individual snapshot jobs are available for facilities, meters, geometry context, signs, and rule rebuilding. Successful full snapshots atomically replace the active source version and delete source records that disappeared. A failed or partial snapshot does not replace the prior published version.

```sh
npm run ingest:facilities
npm run ingest:meters
npm run ingest:geometry
npm run ingest:signs
npm run ingest:rules
npm run ingest:refresh-signs
```

Local development checks the official signs dataset revision at startup and then every `SIGN_REFRESH_MINUTES` (six hours by default). It imports and rebuilds curb rules only when the upstream revision changes. Set `ENABLE_SIGN_REFRESH=false` to disable this scheduler; production should run the same command from an authenticated scheduled job.

## Source safety gates

| Dataset | Maximum age | Behavior after gate |
|---|---:|---|
| Parking signs | 48 hours | dependent curb classifications become gray |
| DCWP licensed facilities | 14 days | facility directory returns unavailable |
| Meters and geometry context | 62 days | dependent curb classifications become gray |

Street Pavement Ratings data is context only and is never marked as DOT-approved curb-side geometry. The hydrant viewport publishes authoritative NYC DEP points with approximate 15-foot advisory radius circles. Those circles are not curb-linked extents, and exact red curb segments remain disabled pending validated DOT side linkage.

For the local pilot, the official NYC DOT ParkNYC Block Faces snapshot provides a bounded geometry fallback. A blockface may be drawn yellow only when the active meter snapshot is fresh, its side is unambiguous, its all-vehicle paid schedule covers the complete requested interval, and no active result depends on sign interpretation. It may be drawn reference-only red when a fresh signs snapshot supplies a supported, high-confidence no-parking rule that overlaps the interval. It may be drawn reference-only green outside those scheduled windows only when a fresh signs snapshot is linked, every regulatory sign is recognized, and the meter schedule is parseable for the full interval. Informational sign companions such as Pay-by-Cell locator and bus route panels do not create curb rules. Unresolved regulatory signs remain gray. Every fallback line remains `geometryValidated: false` and never recommendation-eligible: it is an informational blockface estimate, not a claim about exact curb clearance or physical space availability. Meter pages are staged in bulk so loading the roughly citywide 11,000-row source does not issue one database write per row.

The interval evaluator includes a reviewed 2026 NYC DOT Alternate Side Parking suspension snapshot. It distinguishes ordinary ASP-only suspensions, Sundays, and major legal holidays, and only suppresses rules explicitly tagged as alternate-side or meter rules. Years without a reviewed snapshot remain unknown. Emergency suspensions still require an approved live NYC 311 feed; users are told to verify 311 and posted signs.

## Operations

Liveness contains no counts, versions, schema, or ingestion details. Protected readiness exposes database, migration, feature-flag, and latest-ingestion state for operations staff. Logs include request IDs, method, path without query coordinates, response status, and duration. Exact origin/destination coordinates are not logged.

OpenTripPlanner and MTA credentials are configuration boundaries only. Transit remains disabled until the isolated router, required feed agreements, realtime lag rules, round-trip parking interval validation, and accessibility corpus are complete.
