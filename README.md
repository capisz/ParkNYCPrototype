# Pidge

Pidge is a NYC parking guidance prototype with a native SwiftUI client and a
Node/PostGIS API. Street colors are intended to communicate whether a curb is
restricted, paid, free, or unknown at a selected time.

## Current applications

- `ParkNYCPrototype/`: native SwiftUI iOS application.
- `backend/`: Express, TypeScript, PostgreSQL, and PostGIS API and ingestion jobs.
- `docs/architecture/`: C4-style architecture diagrams.

The revival branch adds an interactive browser companion while preserving the
native application. See `docs/revival-baseline.md` for local recovery commands
and verified toolchain status.

## Local development

On a Mac where the system PostgreSQL server is administrator-controlled, create
Pidge's isolated user-owned PostgreSQL/PostGIS cluster without `sudo`:

```sh
npm run db:bootstrap
npm --prefix backend run ingest:all
```

The cluster is stored outside Git at
`~/Library/Application Support/Pidge/Postgres18` and listens only on
`127.0.0.1:55432`. Its generated application credential is written to the
ignored `backend/.env` file. On later launches, start the database and app with:

```sh
npm run dev:live
```

For a separately managed PostgreSQL server, create `backend/.env` from the
example and set a rotated `DATABASE_URL`, then:

```sh
npm install
npm install --prefix backend
npm install --prefix web
npm run dev
```

The API listens on `http://127.0.0.1:8080` and the browser client on the Vite
URL printed in the terminal. Run `npm test` and `npm run build` before pushing.

To inspect the interactive UI before database credentials are configured, run
`npm run dev:preview`. The browser clearly labels simulated curb lines as
preview data while NYC search, garage, and hydrant proxy routes remain live.
