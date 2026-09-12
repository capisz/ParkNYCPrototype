# Recordable web demo

The iOS client uses SwiftUI; the separate `web/` client uses React/Vite and works in desktop and mobile browsers. The normal web client calls `/api/v1/*`. Vite proxies those requests locally, but those proxy settings do not deploy an API. A live deployment also needs the Express backend, Postgres/PostGIS, data ingestion, and appropriate feature configuration.

## Run locally

From the repository root:

```sh
npm ci --prefix web
npm --prefix web run build:demo
npm --prefix web run preview -- --host 0.0.0.0 --port 4189 --strictPort
```

Open http://localhost:4189. For a phone on the same Wi-Fi, use the Network URL printed by the server. For a phone-shaped recording on your computer, enable your browser's responsive device view at 390 × 844.

Search for **Empire State Building**, **Bryant Park**, or **Times Square**, select the suggestion, choose arrival/departure times, and find parking options. Explore the map, results, filters, and change-plan flow.

Demo mode supplies fictional curb examples in the browser. Search is limited to the three sample destinations; garage and hydrant lists are empty, and transit is unavailable. Map tiles still need internet access. The notice stays visible on both planner and map. This demonstrates the web interface, not an emulated native iOS app or live parking availability.

## Deploy the demo to Vercel

The root `vercel.json` configures installation of web dependencies, `build:demo`, and the `web/dist` output. Import the repository with **Root Directory set to the repository root** (leave it blank), and use Node 22.12+ (Node 22 is suitable). Remove conflicting dashboard build/output overrides. No database, backend, or secret environment variables are needed for this demo.

If you instead set Vercel's Root Directory to `web`, use install command `npm ci`, build command `npm run build:demo`, and output directory `dist`.

Deploy the latest `main` branch from `capisz/ParkNYCPrototype` after these changes are pushed. This guide configures the standalone demo, not a live parking-data backend.

## Live mode remains separate

`npm --prefix web run build` builds the live client. The demo flag is set only by `.env.demo` when `--mode demo` is used. Live request failures never silently become fictional results. To deploy live mode, replace the demo build command and configure the actual API/database hosting and same-origin API routing.
