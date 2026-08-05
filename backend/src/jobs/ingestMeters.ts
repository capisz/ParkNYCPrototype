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

type Coord = [number, number];

type MeterStageRow = {
  blockfaceKey: string;
  borough: string | null;
  onStreet: string | null;
  fromStreet: string | null;
  toStreet: string | null;
  sideOfStreet: string | null;
  meterRate: string | null;
  paidHours: string | null;
  payByCell: string | null;
  geomWkt: string;
  payload: string;
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractLongestLine(geom: unknown): Coord[] | null {
  if (!geom || typeof geom !== "object") return null;
  const candidate = geom as { type?: string; coordinates?: unknown };
  if (!Array.isArray(candidate.coordinates)) return null;
  const lines = candidate.type === "LineString" ? [candidate.coordinates] : candidate.coordinates;
  let best: Coord[] = [];
  for (const lineUnknown of lines as unknown[]) {
    if (!Array.isArray(lineUnknown)) continue;
    const line = lineUnknown.map(pair => Array.isArray(pair) && pair.length >= 2
      ? [Number(pair[0]), Number(pair[1])] as Coord : null)
      .filter((pair): pair is Coord => pair != null && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
    if (line.length > best.length) best = line;
  }
  return best.length >= 2 ? best : null;
}

function lineToWkt(coords: Coord[]): string {
  return `LINESTRING(${coords.map(([lon, lat]) => `${lon} ${lat}`).join(", ")})`;
}

function payloadHash(input: unknown): string {
  return createHash("sha1").update(JSON.stringify(input) ?? "").digest("hex");
}

function toMeterStageRow(row: Record<string, unknown>): MeterStageRow | null {
  const borough = asString(row.borough);
  const onStreet = asString(row.on_street);
  const fromStreet = asString(row.from_stree);
  const toStreet = asString(row.to_street);
  const sideOfStreet = asString(row.side_of_st);
  const blockfaceKey = buildBlockfaceKey({ borough, onStreet, fromStreet, toStreet, sideOfStreet });
  const coordinates = extractLongestLine(row.the_geom);
  if (!isBlockfaceKeyUsable(blockfaceKey) || !coordinates) return null;
  return {
    blockfaceKey,
    borough,
    onStreet,
    fromStreet,
    toStreet,
    sideOfStreet,
    meterRate: asString(row.meter_rate),
    paidHours: asString(row.all_vehi_1),
    payByCell: asString(row.pay_by_cel),
    geomWkt: lineToWkt(coordinates),
    payload: JSON.stringify({ ...row, _payload_hash: payloadHash(row) })
  };
}

async function upsertMeterStage(
  client: import("pg").PoolClient,
  rows: MeterStageRow[]
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(`
    INSERT INTO meters_stage (
      blockface_key, borough, on_street, from_street, to_street,
      side_of_street, meter_rate, paid_hours, pay_by_cell, geom_wkt, payload
    )
    SELECT * FROM UNNEST(
      $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
      $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::jsonb[]
    )
    ON CONFLICT (blockface_key) DO UPDATE SET
      borough = EXCLUDED.borough, on_street = EXCLUDED.on_street,
      from_street = EXCLUDED.from_street, to_street = EXCLUDED.to_street,
      side_of_street = EXCLUDED.side_of_street, meter_rate = EXCLUDED.meter_rate,
      paid_hours = EXCLUDED.paid_hours, pay_by_cell = EXCLUDED.pay_by_cell,
      geom_wkt = EXCLUDED.geom_wkt, payload = EXCLUDED.payload
  `, [
    rows.map(row => row.blockfaceKey), rows.map(row => row.borough),
    rows.map(row => row.onStreet), rows.map(row => row.fromStreet),
    rows.map(row => row.toStreet), rows.map(row => row.sideOfStreet),
    rows.map(row => row.meterRate), rows.map(row => row.paidHours),
    rows.map(row => row.payByCell), rows.map(row => row.geomWkt),
    rows.map(row => row.payload)
  ]);
}

export async function ingestMeters(): Promise<void> {
  const run = await startIngestionRun("meters", config.nycMeterDatasetId);
  const client = await pool.connect();
  const keys = new Set<string>();
  let page = 0;
  let offset = 0;
  let hitPageLimit = false;
  let geometryValidated = false;

  try {
    await client.query(`
      CREATE TEMP TABLE meters_stage (
        blockface_key TEXT PRIMARY KEY,
        borough TEXT,
        on_street TEXT,
        from_street TEXT,
        to_street TEXT,
        side_of_street TEXT,
        meter_rate TEXT,
        paid_hours TEXT,
        pay_by_cell TEXT,
        geom_wkt TEXT NOT NULL,
        payload JSONB NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);
    const select = [
      "the_geom", "pay_by_cel", "all_vehi_1", "meter_rate", "on_street",
      "side_of_st", "from_stree", "to_street", "borough"
    ].join(",");

    while (true) {
      if (config.nycMaxPages > 0 && page >= config.nycMaxPages) {
        hitPageLimit = true;
        break;
      }
      const rows = await fetchSocrataRows({
        datasetId: config.nycMeterDatasetId,
        select,
        offset,
        limit: config.nycPageLimit,
        where: "the_geom IS NOT NULL",
        orderBy: "on_street"
      });
      if (rows.length === 0) break;
      page += 1;
      const stagedPage = new Map<string, MeterStageRow>();
      for (const row of rows) {
        const stageRow = toMeterStageRow(row);
        if (!stageRow) continue;
        keys.add(stageRow.blockfaceKey);
        stagedPage.set(stageRow.blockfaceKey, stageRow);
      }
      await upsertMeterStage(client, [...stagedPage.values()]);
      offset += rows.length;
      console.log(`[ingest:meters] staged page=${page} rows=${rows.length} unique=${keys.size}`);
      if (rows.length < config.nycPageLimit) break;
    }

    if (hitPageLimit && !config.allowPartialIngest) {
      throw new Error("Refusing to publish a partial meter snapshot. Remove NYC_MAX_PAGES or explicitly allow a partial development ingest.");
    }

    const geometryDecision = await client.query<{ approved: boolean }>(`
      SELECT status = 'approved' AND (expires_at IS NULL OR expires_at > now()) AS approved
      FROM data_stewardship_decisions
      WHERE decision_key = 'curb-geometry-authority'
    `);
    geometryValidated = config.trustMeterGeometry && geometryDecision.rows[0]?.approved === true;

    await client.query("BEGIN");
    if (!hitPageLimit) {
      await client.query(`
        DELETE FROM meter_blockfaces_raw current
        WHERE NOT EXISTS (SELECT 1 FROM meters_stage stage WHERE stage.blockface_key = current.blockface_key)
      `);
      await client.query(`
        DELETE FROM curb_segments current
        WHERE current.source = $1
          AND NOT EXISTS (SELECT 1 FROM meters_stage stage WHERE stage.blockface_key = current.blockface_key)
      `, [`meters:${config.nycMeterDatasetId}`]);
    }
    await client.query(`
      INSERT INTO meter_blockfaces_raw (
        blockface_key, borough, on_street, from_street, to_street, side_of_street,
        meter_rate, paid_hours, pay_by_cell, payload, source_updated_at, ingested_at, source_run_id
      ) SELECT blockface_key, borough, on_street, from_street, to_street, side_of_street,
        meter_rate, paid_hours, pay_by_cell, payload, $2, now(), $1
      FROM meters_stage
      ON CONFLICT (blockface_key) DO UPDATE SET
        borough = EXCLUDED.borough, on_street = EXCLUDED.on_street,
        from_street = EXCLUDED.from_street, to_street = EXCLUDED.to_street,
        side_of_street = EXCLUDED.side_of_street, meter_rate = EXCLUDED.meter_rate,
        paid_hours = EXCLUDED.paid_hours, pay_by_cell = EXCLUDED.pay_by_cell,
        payload = EXCLUDED.payload, source_updated_at = EXCLUDED.source_updated_at,
        ingested_at = now(), source_run_id = EXCLUDED.source_run_id
    `, [run.id, run.sourceUpdatedAt]);
    await client.query(`
      INSERT INTO curb_segments (
        blockface_key, borough, on_street, from_street, to_street, side_of_street,
        meter_rate, paid_hours, pay_by_cell, source, geom, updated_at,
        source_run_id, source_updated_at, geometry_validated, interpretation_version
      ) SELECT blockface_key, borough, on_street, from_street, to_street, side_of_street,
        meter_rate, paid_hours, pay_by_cell, $3, ST_GeomFromText(geom_wkt, 4326), now(),
        $1, $2, $4, 'parking-rules-v3-public-reference'
      FROM meters_stage
      ON CONFLICT (blockface_key) DO UPDATE SET
        borough = EXCLUDED.borough, on_street = EXCLUDED.on_street,
        from_street = EXCLUDED.from_street, to_street = EXCLUDED.to_street,
        side_of_street = EXCLUDED.side_of_street, meter_rate = EXCLUDED.meter_rate,
        paid_hours = EXCLUDED.paid_hours, pay_by_cell = EXCLUDED.pay_by_cell,
        source = EXCLUDED.source, geom = EXCLUDED.geom, updated_at = now(),
        source_run_id = EXCLUDED.source_run_id, source_updated_at = EXCLUDED.source_updated_at,
        geometry_validated = EXCLUDED.geometry_validated,
        interpretation_version = EXCLUDED.interpretation_version
    `, [run.id, run.sourceUpdatedAt, `meters:${config.nycMeterDatasetId}`, geometryValidated]);
    await publishIngestionRun(client, run, keys.size, snapshotChecksum(keys), {
      partial: hitPageLimit, pages: page, geometryValidated,
      geometryApprovalRequired: config.trustMeterGeometry && !geometryValidated
    });
    await client.query("COMMIT");
    console.log(`[ingest:meters] published run=${run.id} rows=${keys.size} partial=${hitPageLimit}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await failIngestionRun(run, error);
    throw error;
  } finally {
    await client.query("DROP TABLE IF EXISTS meters_stage").catch(() => undefined);
    client.release();
  }
}

export const meterIngestionInternals = { extractLongestLine, lineToWkt, toMeterStageRow };

if (require.main === module) {
  ingestMeters().then(async () => { await pool.end(); process.exit(0); })
    .catch(async error => { console.error("[ingest:meters] failed", error); await pool.end(); process.exit(1); });
}
