# Pidge Parking Backend (NYC)

This service ingests NYC open parking + street geometry data into Postgres/PostGIS, builds per-blockface parking rules, and serves viewport GeoJSON for map coloring:

- `no_parking` => red
- `paid` => yellow
- `free` => green
- `unknown` => gray

## 1) Prerequisites

- Node.js 20+
- Postgres 14+ running locally
- PostGIS extension available
- Optional but recommended: NYC Open Data app token

## 2) Environment

Copy example env and fill values:

```bash
cd /Users/admin/Desktop/projects/ParkNYCPrototype/backend
cp .env.example .env
```

Set `DATABASE_URL` to your real DB credentials.

## 3) Postgres setup

For the repository-managed, no-`sudo` macOS cluster, run from the repository
root:

```bash
npm run db:bootstrap
```

This creates an isolated cluster under
`~/Library/Application Support/Pidge/Postgres18` on port `55432`.

For an independently managed PostgreSQL server, open `psql` first:


```bash
psql -U postgres
```

Then run:

```sql
CREATE ROLE pidge_app WITH LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE pidge_parking OWNER pidge_app;
\c pidge_parking
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\q
```

## 4) Install + migrate + ingest

```bash
cd /Users/admin/Desktop/projects/ParkNYCPrototype/backend
npm install
npm run migrate
npm run ingest:all
```

If you already ingested older data before geometry support was added, run this again so citywide geometry is loaded:

```bash
npm run migrate
npm run ingest:geometry
npm run ingest:rules
```

You can rerun ingestion later:

```bash
npm run ingest:meters
npm run ingest:geometry
npm run ingest:signs
npm run ingest:rules
```

## 5) Start API

```bash
npm run dev
```

Health check:

```bash
curl -s "http://localhost:8080/health"
```

Proximity API example:

```bash
curl -s "http://localhost:8080/api/parking/viewport?minLat=40.740&minLng=-74.000&maxLat=40.760&maxLng=-73.970&centerLat=40.750&centerLng=-73.985&radiusMeters=450&zoom=16.5"
```

Response is GeoJSON `FeatureCollection` with `properties.status` and `properties.color` for direct map rendering.
`http://localhost:8080/` now returns a small route index; it is no longer a 404.

## Proximity loading

- City-scale curb requests are rejected before PostGIS is queried.
- Street overlays begin at client zoom `16` and are clipped in PostGIS to a
  `100-1500 m` circle around the current map center.
- Panning cancels stale browser requests; `moveend` loads only the new scope.
- Hydrants and their 15-foot curb restrictions begin at zoom `19`.
- Green requires either an explicit permission sign or a reliable known
  schedule with no active restriction and no unresolved parking evidence.
  Missing data remains gray rather than being inferred as free.

## Coverage notes

- Geometry source is `6yyb-pb25` (Street Pavement Rating roadway segments), giving near-citywide street line coverage.
- Parking rules are matched using exact blockface keys plus side-agnostic (`borough|on|from|to`) matching, so sign-based rules can classify non-meter segments.

## Notes

- The parser supports structured weekday, overnight, noon, midnight, meter,
  and anytime schedules, but additional NYC sign grammar still needs fixtures.
- If NYC API rate limits you, set `NYC_APP_TOKEN` in `.env`.
