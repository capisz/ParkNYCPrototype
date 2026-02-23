# Pidge Parking Backend (NYC)

This service ingests NYC open parking + street geometry data into Postgres/PostGIS, builds per-blockface parking rules, and serves viewport GeoJSON for map coloring:

- `no_parking` => red
- `paid` => yellow
- `free` => green

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

Open `psql` first (this is required before running SQL):

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

Viewport API example:

```bash
curl -s "http://localhost:8080/api/parking/viewport?minLat=40.741&minLng=-74.006&maxLat=40.757&maxLng=-73.983"
```

Response is GeoJSON `FeatureCollection` with `properties.status` and `properties.color` for direct map rendering.
`http://localhost:8080/` now returns a small route index; it is no longer a 404.

## Coverage notes

- Geometry source is `6yyb-pb25` (Street Pavement Rating roadway segments), giving near-citywide street line coverage.
- Parking rules are matched using exact blockface keys plus side-agnostic (`borough|on|from|to`) matching, so sign-based rules can classify non-meter segments.

## Notes

- This backend currently uses heuristic rule-building from meter + sign text.
- To improve precision citywide, parse sign schedule grammar into structured day/time windows in `curb_rules`.
- If NYC API rate limits you, set `NYC_APP_TOKEN` in `.env`.
