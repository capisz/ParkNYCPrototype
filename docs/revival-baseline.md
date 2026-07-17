# Revival baseline

Baseline date: 2026-07-16

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
- PostgreSQL does not allow passwordless access for the current macOS user or
  `pidge_app`. Add a rotated `DATABASE_URL` to ignored `backend/.env` before
  running migrations, health checks, or ingestion. Previously shared database
  and Socrata credentials must not be reused.

## Recovery commands

```sh
git clone https://github.com/capisz/ParkNYCPrototype.git
cd ParkNYCPrototype
git switch -c codex/revival-mvp

cp backend/.env.example backend/.env
# Set a newly issued DATABASE_URL. NYC_APP_TOKEN is optional for local recovery.

cd backend
npm ci
npm run migrate
npm run dev
```

After database access is configured, verify:

```sh
curl http://127.0.0.1:8080/health
curl 'http://127.0.0.1:8080/api/parking/viewport?minLat=40.748&minLng=-73.990&maxLat=40.753&maxLng=-73.980'
```
