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

