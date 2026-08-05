import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { pool } from "../db";
import { config } from "../config";

export type IngestionRun = {
  id: string;
  datasetKey: "geometry" | "meters" | "signs" | "facilities";
  sourceDatasetId: string;
  sourceUpdatedAt: Date | null;
};

type SocrataMetadata = {
  rowsUpdatedAt?: number;
  rowsUpdatedBy?: string;
  name?: string;
  viewLastModified?: number;
};

function sourceMetadataUrl(datasetId: string): URL {
  const resource = new URL(config.nycBaseUrl);
  return new URL(`/api/views/${datasetId}`, resource.origin);
}

export async function fetchSourceUpdatedAt(datasetId: string): Promise<Date | null> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (config.nycAppToken) headers["X-App-Token"] = config.nycAppToken;
    const response = await fetch(sourceMetadataUrl(datasetId), {
      headers,
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return null;
    const metadata = await response.json() as SocrataMetadata;
    const seconds = metadata.rowsUpdatedAt ?? metadata.viewLastModified;
    return typeof seconds === "number" ? new Date(seconds * 1_000) : null;
  } catch {
    return null;
  }
}

export async function startIngestionRun(
  datasetKey: IngestionRun["datasetKey"],
  sourceDatasetId: string
): Promise<IngestionRun> {
  const sourceUpdatedAt = await fetchSourceUpdatedAt(sourceDatasetId);
  const result = await pool.query<{ id: string }>(`
    INSERT INTO ingestion_runs (
      dataset_key, source_dataset_id, status, source_updated_at
    ) VALUES ($1, $2, 'running', $3)
    RETURNING id::text
  `, [datasetKey, sourceDatasetId, sourceUpdatedAt]);
  return { id: result.rows[0].id, datasetKey, sourceDatasetId, sourceUpdatedAt };
}

export function snapshotChecksum(keys: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const key of [...keys].sort()) hash.update(key).update("\n");
  return hash.digest("hex");
}

export async function publishIngestionRun(
  client: PoolClient,
  run: IngestionRun,
  rowCount: number,
  checksum: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await client.query(`
    UPDATE ingestion_runs
    SET status = 'superseded'
    WHERE dataset_key = $1 AND status = 'published' AND id <> $2
  `, [run.datasetKey, run.id]);
  await client.query(`
    UPDATE ingestion_runs
    SET status = 'published', completed_at = now(), published_at = now(),
      row_count = $2, checksum = $3, metadata = $4::jsonb
    WHERE id = $1
  `, [run.id, rowCount, checksum, JSON.stringify(metadata)]);
}

export async function failIngestionRun(run: IngestionRun, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(`
    UPDATE ingestion_runs
    SET status = 'failed', completed_at = now(),
      validation_errors = jsonb_build_array(jsonb_build_object('message', $2::text))
    WHERE id = $1
  `, [run.id, message.slice(0, 2_000)]).catch(() => undefined);
}
