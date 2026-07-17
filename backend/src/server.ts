import express from "express";
import { config } from "./config";
import { pool } from "./db";
import parkingRoutes from "./routes/parking";
import externalRoutes from "./routes/external";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const elapsedMs = Date.now() - startedAt;
      console.log(`${req.method} ${req.path} -> ${res.statusCode} (${elapsedMs}ms)`);
    });
    next();
  });

  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      service: "pidge-parking-backend",
      routes: {
        health: "/health",
        viewport: "/api/parking/viewport?minLat=40.741&minLng=-74.006&maxLat=40.757&maxLng=-73.983"
      }
    });
  });

  app.get("/health", async (_req, res) => {
    try {
      const counts = await pool.query(`SELECT
        (SELECT count(*)::int FROM curb_segments) AS curb_segments,
        (SELECT count(*)::int FROM curb_rules) AS curb_rules,
        (SELECT count(*)::int FROM parking_signs_raw) AS parking_signs,
        (SELECT count(*)::int FROM meter_blockfaces_raw) AS meters`);
      const migrations = await pool.query("SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1").catch(() => ({ rows: [] }));
      res.json({ ok: true, database: "connected", timezone: config.timezone, migration: migrations.rows[0] ?? null, rowCounts: counts.rows[0], checkedAt: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ ok: false, error: "db_unavailable" });
    }
  });

  app.use("/api/parking", parkingRoutes);
  app.use("/api", externalRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

async function start(): Promise<void> {
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received; shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (require.main === module) {
  start().catch(async (error) => {
    console.error("[server] startup failed", error);
    await pool.end();
    process.exit(1);
  });
}
