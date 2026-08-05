# Revival baseline

Baseline date: 2026-07-16

> Historical recovery record only. The public-pilot safety audit supersedes the classifications, hydrant geometry, health route, and unversioned API commands below. Do not use this file as current operational guidance; see [the pilot implementation status](./pilot-readiness/IMPLEMENTATION_STATUS.md).

## Recovered revision

- Repository: `capisz/ParkNYCPrototype`
- Base branch: `main`
- Base commit: `d33db56366af5f6640895fca78aaf1ea39f6ad47`
- Working branch: `codex/revival-mvp`

## Verified locally

- Node.js `24.10.0` and npm `11.6.0`.
- Xcode `26.6` (`17F113`).
- PostgreSQL accepts TCP connections on `localhost:5432`.
- `npm ci`, `npm run typecheck`, and `npm run build` pass in `backend/`.
- The SwiftUI target builds with the iOS Simulator SDK:

```sh
xcodebuild \
  -project ParkNYCPrototype.xcodeproj \
  -scheme ParkNYCPrototype \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/PidgeDerivedData \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Known local blockers

- Simulator device launch is blocked because the installed CoreSimulator
  framework is version `1051.54.0`, while Xcode expects `1051.55.0`. Generic
  simulator builds still succeed. Updating macOS/Xcode's simulator components
  is required before install, launch, and native screenshot capture.
- The administrator-owned PostgreSQL server on port `5432` cannot be managed by
  this macOS account. Pidge now uses an isolated, user-owned PostgreSQL 18 and
  PostGIS 3.6 cluster on `127.0.0.1:55432` instead.

## Live data recovery

Verified on 2026-07-17 without reusing previously shared credentials:

- `114,853` curb segments.
- `246,697` parsed curb rules.
- `235,551` parking sign rows after source-key deduplication.
- `11,156` meter rows after source-key deduplication.
- Live NYCDEP hydrants return curb-snapped 15-foot restriction segments.
- A Midtown proximity query returns database-backed `no_parking`, `paid`,
  evidence-backed `free`, and conservative `unknown` classifications.
- City-scale curb queries are rejected; clients load circular street-level
  scopes and reveal hydrants only at block-level zoom.

## Recovery commands

```sh
git clone https://github.com/capisz/ParkNYCPrototype.git
cd ParkNYCPrototype
git switch -c codex/revival-mvp

npm install
npm install --prefix backend
npm install --prefix web
npm run db:bootstrap
npm --prefix backend run ingest:all
npm run dev:live
```

After database access is configured, verify:

```sh
curl http://127.0.0.1:8080/health
curl 'http://127.0.0.1:8080/api/parking/viewport?minLat=40.748&minLng=-73.990&maxLat=40.753&maxLng=-73.980'
```
