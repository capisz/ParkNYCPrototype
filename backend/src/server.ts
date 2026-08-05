import { randomUUID, timingSafeEqual } from "crypto";
import compression from "compression";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { config } from "./config";
import { pool } from "./db";
import { openApiDocument } from "./openapi";
import { startSignRefreshScheduler } from "./jobs/refreshSigns";
import externalRoutes from "./routes/external";
import parkingRoutes from "./routes/parking";

function authorizedOperationsRequest(header: string | undefined): boolean {
  if (!config.operationsToken || !header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(config.operationsToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createApp() {
  const app = express();
  if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

  app.disable("x-powered-by");
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "same-site" },
    contentSecurityPolicy: false
  }));
  app.use(compression());
  app.use(express.json({ limit: "256kb" }));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === "test" ? 10_000 : 180,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "rate_limited" }
  }));

  app.use((req, res, next) => {
    const requestId = req.header("x-request-id")?.slice(0, 100) || randomUUID();
    const startedAt = Date.now();
    res.setHeader("x-request-id", requestId);
    res.setHeader("cache-control", "no-store");
    res.on("finish", () => {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: res.statusCode >= 500 ? "error" : "info",
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt
      }));
    });
    next();
  });

  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      service: "nyc-parking-planner-api",
      apiVersion: "v1",
      advisory: true,
      documentation: "/openapi.json"
    });
  });
  app.get("/openapi.json", (_req, res) => {
    res.setHeader("cache-control", "public, max-age=300");
    res.json(openApiDocument);
  });

  const liveness = (_req: express.Request, res: express.Response) => {
    res.json({ ok: true, service: "nyc-parking-planner-api" });
  };
  app.get("/livez", liveness);
  app.get("/health", liveness);

  app.get("/readyz", async (req, res) => {
    if (!authorizedOperationsRequest(req.header("authorization"))) {
      return void res.status(401).json({ error: "unauthorized" });
    }
    try {
      const database = await pool.query("SELECT 1 AS ready");
      const runs = await pool.query(`
        SELECT DISTINCT ON (dataset_key)
          dataset_key, source_dataset_id, status, source_updated_at, source_checked_at,
          published_at, row_count, checksum
        FROM ingestion_runs
        ORDER BY dataset_key, started_at DESC
      `);
      const migration = await pool.query(
        "SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"
      );
      res.json({
        ok: database.rows[0]?.ready === 1,
        migration: migration.rows[0] ?? null,
        ingestionRuns: runs.rows,
        features: config.features,
        checkedAt: new Date().toISOString()
      });
    } catch {
      res.status(503).json({ ok: false, error: "not_ready" });
    }
  });

  app.use("/api/v1", parkingRoutes);
  app.use("/api/v1", externalRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}

async function start(): Promise<void> {
  const app = createApp();
  const stopSignRefresh = startSignRefreshScheduler();
  const server = app.listen(config.port, () => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "server_started",
      port: config.port
    }));
  });

  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event: "shutdown", signal }));
    stopSignRefresh();
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (require.main === module) {
  start().catch(async (error) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(), level: "error", event: "startup_failed",
      message: error instanceof Error ? error.message : String(error)
    }));
    await pool.end();
    process.exit(1);
  });
}
