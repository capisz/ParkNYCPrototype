# NYC Parking Planner

NYC Parking Planner is an anonymous, advisory web and iOS parking-planning service under a public-pilot safety hold. Pidge is a supporting guide; posted signs, meter or ParkNYC instructions, facility terms, and current transit conditions remain authoritative.

The current implementation fails closed:

- Red means cannot park, yellow means paid parking, green means free parking, and gray means unknown.
- Gray and red curbs are never recommendation candidates.
- Arrival and leave times are required; every classification covers the complete interval.
- Street centerlines are not represented as approved curb-side geometry. Curbs remain gray until NYC DOT approves side and extent.
- Facilities come only from a staged snapshot of active `Garage & Parking Lot` licenses in NYC DCWP Issued Licenses. Price, capacity, and physical availability are not claimed.
- Park-and-ride is disabled until the OTP/MTA, realtime, return-trip, and accessibility validation gates pass.
- There are no accounts, saved trips, payments, reservations, enforcement decisions, or sign-scanning/camera flow.

## Applications

- `web/`: React/Vite responsive planner and map.
- `ParkNYCPrototype/`: SwiftUI iOS 17+ client using the same v1 backend contract.
- `backend/`: Express/TypeScript, Postgres/PostGIS, staged ingestion, freshness gates, and versioned advisory APIs.
- `docs/pilot-readiness/`: ownership, decisions, risks, release gates, operations, privacy, and accessibility records.

## Local development

Bootstrap the repository-managed Postgres/PostGIS cluster and load source snapshots:

```sh
npm run db:bootstrap
npm --prefix backend run ingest:all
```

The development cluster listens on `127.0.0.1:55432`; its generated credential is written to ignored `backend/.env`. A City-managed Socrata app token is required before production ingestion, but public Open Data endpoints remain usable without a token for development.

Start the API and web client:

```sh
npm run dev:live
```

Run the verification suite:

```sh
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm --prefix web run test:e2e
```

The iOS target can be compiled without signing using the shared `ParkNYCPrototype` scheme. Simulator/runtime validation still requires a compatible CoreSimulator installation and a real-device release gate.

## Safety and release status

This repository is not an authorized NYC production service. The web header deliberately says “Prototype for City review” unless `VITE_CITY_APPROVED_RELEASE=true` is set by an approved release pipeline. Production feature flags default closed, protected readiness requires an operations token, and dataset-specific gates can disable curb, facility, or transit results without redeploying.

See [implementation status](docs/pilot-readiness/IMPLEMENTATION_STATUS.md) for what is implemented versus what still requires DOT, OTI, DCWP, MTA, accessibility, translation, security, and field-validation approval.
