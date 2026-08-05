import { createHash } from "crypto";
import { pool } from "../db";
import { config } from "../config";
import { buildBlockfaceKey, isBlockfaceKeyUsable } from "../lib/blockface";
import {
  failIngestionRun,
  publishIngestionRun,
  snapshotChecksum,
  startIngestionRun
} from "../lib/ingestionRun";
import { fetchSocrataRows } from "../lib/socrata";

type SignStageRow = {
  fingerprint: string;
  blockfaceKey: string;
  orderNumber: string | null;
  recordType: string | null;
  signCode: string | null;
  signDescription: string | null;
  orderCompletedOnDate: string | null;
  payload: string;
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDateOrNull(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function buildFingerprint(input: {
  blockfaceKey: string;
  orderNumber: string | null;
  signCode: string | null;
  signDescription: string | null;
  recordType: string | null;
}): string {
  return createHash("sha1").update([
    input.blockfaceKey, input.orderNumber ?? "", input.signCode ?? "",
    input.signDescription ?? "", input.recordType ?? ""
  ].join("|")).digest("hex");
}

function toSignStageRow(row: Record<string, unknown>): SignStageRow | null {
  const blockfaceKey = buildBlockfaceKey({
    borough: asString(row.borough), onStreet: asString(row.on_street),
    fromStreet: asString(row.from_street), toStreet: asString(row.to_street),
    sideOfStreet: asString(row.side_of_street)
  });
  if (!isBlockfaceKeyUsable(blockfaceKey)) return null;
  const orderNumber = asString(row.order_number);
  const signCode = asString(row.sign_code);
  const signDescription = asString(row.sign_description);
  const recordType = asString(row.record_type);
  return {
    fingerprint: buildFingerprint({ blockfaceKey, orderNumber, signCode, signDescription, recordType }),
    blockfaceKey,
    orderNumber,
    recordType,
    signCode,
    signDescription,
    orderCompletedOnDate: toDateOrNull(asString(row.order_completed_on_date)),
    payload: JSON.stringify(row)
  };
}

async function upsertSignStage(client: import("pg").PoolClient, rows: SignStageRow[]): Promise<void> {
  if (rows.length === 0) return;
  await client.query(`
    INSERT INTO signs_stage (
      fingerprint, blockface_key, order_number, record_type, sign_code,
      sign_description, order_completed_on_date, payload
    )
    SELECT * FROM UNNEST(
      $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
      $6::text[], $7::date[], $8::jsonb[]
    )
    ON CONFLICT (fingerprint) DO UPDATE SET
      blockface_key = EXCLUDED.blockface_key,
      order_number = EXCLUDED.order_number,
      record_type = EXCLUDED.record_type,
      sign_code = EXCLUDED.sign_code,
      sign_description = EXCLUDED.sign_description,
      order_completed_on_date = EXCLUDED.order_completed_on_date,
      payload = EXCLUDED.payload
  `, [
    rows.map(row => row.fingerprint), rows.map(row => row.blockfaceKey),
    rows.map(row => row.orderNumber), rows.map(row => row.recordType),
    rows.map(row => row.signCode), rows.map(row => row.signDescription),
    rows.map(row => row.orderCompletedOnDate), rows.map(row => row.payload)
  ]);
}

export async function ingestSigns(): Promise<void> {
  const run = await startIngestionRun("signs", config.nycSignsDatasetId);
  const client = await pool.connect();
  const keys = new Set<string>();
  let page = 0;
  let offset = 0;
  let hitPageLimit = false;

  try {
    await client.query(`
      CREATE TEMP TABLE signs_stage (
        fingerprint TEXT PRIMARY KEY,
        blockface_key TEXT NOT NULL,
        order_number TEXT,
        record_type TEXT,
        sign_code TEXT,
        sign_description TEXT,
        order_completed_on_date DATE,
        payload JSONB NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);
    const select = [
      "order_number", "record_type", "borough", "on_street", "from_street",
      "to_street", "side_of_street", "order_completed_on_date", "sign_code", "sign_description"
    ].join(",");

    while (true) {
      if (config.nycMaxPages > 0 && page >= config.nycMaxPages) {
        hitPageLimit = true;
        break;
      }
      const rows = await fetchSocrataRows({
        datasetId: config.nycSignsDatasetId,
        select,
        where: "upper(record_type) = 'CURRENT'",
        orderBy: "order_number",
        offset,
        limit: config.nycPageLimit
      });
      if (rows.length === 0) break;
      page += 1;

      const stagedPage = new Map<string, SignStageRow>();
      for (const row of rows) {
        const stageRow = toSignStageRow(row);
        if (!stageRow) continue;
        keys.add(stageRow.fingerprint);
        stagedPage.set(stageRow.fingerprint, stageRow);
      }
      await upsertSignStage(client, [...stagedPage.values()]);
      offset += rows.length;
      console.log(`[ingest:signs] staged page=${page} rows=${rows.length} unique=${keys.size}`);
      if (rows.length < config.nycPageLimit) break;
    }

    if (hitPageLimit && !config.allowPartialIngest) {
      throw new Error("Refusing to publish a partial signs snapshot. Remove NYC_MAX_PAGES or explicitly allow a partial development ingest.");
    }

    await client.query("BEGIN");
    if (!hitPageLimit) {
      await client.query(`
        DELETE FROM parking_signs_raw current
        WHERE NOT EXISTS (SELECT 1 FROM signs_stage stage WHERE stage.fingerprint = current.fingerprint)
      `);
    }
    await client.query(`
      INSERT INTO parking_signs_raw (
        fingerprint, blockface_key, order_number, record_type, sign_code,
        sign_description, order_completed_on_date, payload, source_updated_at,
        ingested_at, source_run_id
      )
      SELECT fingerprint, blockface_key, order_number, record_type, sign_code,
        sign_description, order_completed_on_date, payload, $2, now(), $1
      FROM signs_stage
      ON CONFLICT (fingerprint) DO UPDATE SET
        blockface_key = EXCLUDED.blockface_key,
        order_number = EXCLUDED.order_number,
        record_type = EXCLUDED.record_type,
        sign_code = EXCLUDED.sign_code,
        sign_description = EXCLUDED.sign_description,
        order_completed_on_date = EXCLUDED.order_completed_on_date,
        payload = EXCLUDED.payload,
        source_updated_at = EXCLUDED.source_updated_at,
        ingested_at = now(),
        source_run_id = EXCLUDED.source_run_id
    `, [run.id, run.sourceUpdatedAt]);
    await publishIngestionRun(client, run, keys.size, snapshotChecksum(keys), { partial: hitPageLimit, pages: page });
    await client.query("COMMIT");
    console.log(`[ingest:signs] published run=${run.id} rows=${keys.size} partial=${hitPageLimit}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await failIngestionRun(run, error);
    throw error;
  } finally {
    await client.query("DROP TABLE IF EXISTS signs_stage").catch(() => undefined);
    client.release();
  }
}

export const signIngestionInternals = { buildFingerprint, toDateOrNull, toSignStageRow };

if (require.main === module) {
  ingestSigns().then(async () => { await pool.end(); process.exit(0); })
    .catch(async error => { console.error("[ingest:signs] failed", error); await pool.end(); process.exit(1); });
}
