import { config } from "../config";
import { pool } from "../db";
import { fetchSourceUpdatedAt } from "../lib/ingestionRun";
import { ingestSigns } from "./ingestSigns";
import { rebuildRules } from "./rebuildRules";

const REFRESH_LOCK_KEY = 1_904_275_113;

export type SignRefreshResult = {
  refreshed: boolean;
  sourceUpdatedAt: string;
  reason: "source_changed" | "already_current" | "refresh_in_progress";
};

export function sourceNeedsRefresh(
  activeRevision: Date | null,
  upstreamRevision: Date
): boolean {
  return activeRevision == null || !Number.isFinite(activeRevision.getTime()) ||
    activeRevision.getTime() < upstreamRevision.getTime();
}

export async function refreshSignsIfNeeded(): Promise<SignRefreshResult> {
  const sourceUpdatedAt = await fetchSourceUpdatedAt(config.nycSignsDatasetId);
  if (!sourceUpdatedAt) throw new Error("Unable to verify the NYC parking-sign source revision.");

  const lockClient = await pool.connect();
  let locked = false;
  try {
    const lock = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [REFRESH_LOCK_KEY]
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      return {
        refreshed: false,
        sourceUpdatedAt: sourceUpdatedAt.toISOString(),
        reason: "refresh_in_progress"
      };
    }

    const active = await lockClient.query<{ source_updated_at: Date | string | null }>(`
      SELECT source_updated_at
      FROM ingestion_runs
      WHERE dataset_key = 'signs' AND status = 'published'
      ORDER BY published_at DESC NULLS LAST, started_at DESC
      LIMIT 1
    `);
    const activeRevision = active.rows[0]?.source_updated_at == null
      ? null
      : new Date(active.rows[0].source_updated_at);
    if (!sourceNeedsRefresh(activeRevision, sourceUpdatedAt)) {
      await lockClient.query(`
        UPDATE ingestion_runs
        SET source_checked_at = now()
        WHERE dataset_key = 'signs' AND status = 'published'
      `);
      return {
        refreshed: false,
        sourceUpdatedAt: sourceUpdatedAt.toISOString(),
        reason: "already_current"
      };
    }

    await ingestSigns();
    await rebuildRules();
    return {
      refreshed: true,
      sourceUpdatedAt: sourceUpdatedAt.toISOString(),
      reason: "source_changed"
    };
  } finally {
    if (locked) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [REFRESH_LOCK_KEY]).catch(() => undefined);
    }
    lockClient.release();
  }
}

export function startSignRefreshScheduler(): () => void {
  if (!config.enableSignRefresh) return () => undefined;
  let stopped = false;
  let running = false;
  const refresh = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await refreshSignsIfNeeded();
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "sign_refresh_checked",
        ...result
      }));
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "sign_refresh_failed",
        message: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void refresh(), config.signRefreshMinutes * 60_000);
  timer.unref();
  const startup = setTimeout(() => void refresh(), 1_500);
  startup.unref();
  return () => {
    stopped = true;
    clearTimeout(startup);
    clearInterval(timer);
  };
}

if (require.main === module) {
  refreshSignsIfNeeded()
    .then(async result => {
      console.log(`[refresh:signs] ${result.reason} source=${result.sourceUpdatedAt}`);
      await pool.end();
      process.exit(0);
    })
    .catch(async error => {
      console.error("[refresh:signs] failed", error);
      await pool.end();
      process.exit(1);
    });
}
