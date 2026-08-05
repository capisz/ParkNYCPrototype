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

function canonicalBorough(value: string | null): string | null {
  const upper = (value ?? "").trim().toUpperCase();
  if (!upper) return null;
  if (upper.startsWith("MAN")) return "MANHATTAN";
  if (upper.startsWith("BROOK")) return "BROOKLYN";
  if (upper.startsWith("BRON")) return "BRONX";
  if (upper.startsWith("QUE")) return "QUEENS";
  if (upper.startsWith("STATEN")) return "STATEN ISLAND";
  if (upper === "M") return "MANHATTAN";
  if (upper === "B") return "BROOKLYN";
  if (upper === "X") return "BRONX";
  if (upper === "Q") return "QUEENS";
  if (upper === "S" || upper === "R") return "STATEN ISLAND";
  return upper;
}

export async function ingestGeometry(): Promise<void> {
  const run = await startIngestionRun("geometry", config.nycGeometryDatasetId);
  const client = await pool.connect();
  const keys = new Set<string>();
  let page = 0;
  let offset = 0;
  let hitPageLimit = false;
  let skippedDuplicates = 0;

  try {
    await client.query(`
      CREATE TEMP TABLE geometry_stage (
        geometry_key TEXT PRIMARY KEY,
        blockface_key TEXT NOT NULL,
        borough TEXT,
        on_street TEXT,
        from_street TEXT,
        to_street TEXT,
        geom_wkt TEXT NOT NULL,
        payload JSONB NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);
    const select = ["distinct oftcode", "boroughname", "onstreetna", "fromstreet", "tostreetna", "the_geom"].join(",");
    const pageLimit = Math.max(1_000, config.nycGeometryPageLimit);

    while (true) {
      if (config.nycMaxPages > 0 && page >= config.nycMaxPages) {
        hitPageLimit = true;
        break;
      }
      const rows = await fetchSocrataRows({
        datasetId: config.nycGeometryDatasetId,
        select,
        where: "the_geom IS NOT NULL AND oftcode IS NOT NULL AND onstreetna IS NOT NULL AND fromstreet IS NOT NULL AND tostreetna IS NOT NULL",
        orderBy: "oftcode",
        offset,
        limit: pageLimit
      });
      if (rows.length === 0) break;
      page += 1;
      for (const row of rows) {
        const geometryKey = asString(row.oftcode);
        if (!geometryKey) continue;
        if (keys.has(geometryKey)) { skippedDuplicates += 1; continue; }
        const borough = canonicalBorough(asString(row.boroughname));
        const onStreet = asString(row.onstreetna);
        const fromStreet = asString(row.fromstreet);
        const toStreet = asString(row.tostreetna);
        const blockfaceKey = buildBlockfaceKey({
          borough, onStreet, fromStreet, toStreet, sideOfStreet: `SEG-${geometryKey}`
        });
        const coordinates = extractLongestLine(row.the_geom);
        if (!isBlockfaceKeyUsable(blockfaceKey) || !coordinates) continue;
        keys.add(geometryKey);
        const hash = createHash("sha1").update(JSON.stringify(row) ?? "").digest("hex");
        await client.query(`
          INSERT INTO geometry_stage (
            geometry_key, blockface_key, borough, on_street, from_street,
            to_street, geom_wkt, payload
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
          ON CONFLICT (geometry_key) DO UPDATE SET
            blockface_key = EXCLUDED.blockface_key, borough = EXCLUDED.borough,
            on_street = EXCLUDED.on_street, from_street = EXCLUDED.from_street,
            to_street = EXCLUDED.to_street, geom_wkt = EXCLUDED.geom_wkt,
            payload = EXCLUDED.payload
        `, [
          geometryKey, blockfaceKey, borough, onStreet, fromStreet, toStreet,
          lineToWkt(coordinates), JSON.stringify({ ...row, _payload_hash: hash })
        ]);
      }
      offset += rows.length;
      console.log(`[ingest:geometry] staged page=${page} rows=${rows.length} unique=${keys.size}`);
      if (rows.length < pageLimit) break;
    }

    if (hitPageLimit && !config.allowPartialIngest) {
      throw new Error("Refusing to publish a partial geometry snapshot. Remove NYC_MAX_PAGES or explicitly allow a partial development ingest.");
    }

    await client.query("BEGIN");
    if (!hitPageLimit) {
      await client.query(`
        DELETE FROM street_geometry_raw current
        WHERE NOT EXISTS (SELECT 1 FROM geometry_stage stage WHERE stage.geometry_key = current.geometry_key)
      `);
      await client.query(`
        DELETE FROM curb_segments current
        WHERE current.source = $1
          AND NOT EXISTS (SELECT 1 FROM geometry_stage stage WHERE stage.blockface_key = current.blockface_key)
      `, [`geometry:${config.nycGeometryDatasetId}`]);
    }
    await client.query(`
      INSERT INTO street_geometry_raw (
        geometry_key, blockface_key, borough, on_street, from_street, to_street,
        source_updated_at, payload, ingested_at, source_run_id
      ) SELECT geometry_key, blockface_key, borough, on_street, from_street, to_street,
        $2::date, payload, now(), $1
      FROM geometry_stage
      ON CONFLICT (geometry_key) DO UPDATE SET
        blockface_key = EXCLUDED.blockface_key, borough = EXCLUDED.borough,
        on_street = EXCLUDED.on_street, from_street = EXCLUDED.from_street,
        to_street = EXCLUDED.to_street, source_updated_at = EXCLUDED.source_updated_at,
        payload = EXCLUDED.payload, ingested_at = now(), source_run_id = EXCLUDED.source_run_id
    `, [run.id, run.sourceUpdatedAt]);
    await client.query(`
      INSERT INTO curb_segments (
        blockface_key, borough, on_street, from_street, to_street, side_of_street,
        meter_rate, paid_hours, pay_by_cell, source, geom, updated_at,
        source_run_id, source_updated_at, geometry_validated, interpretation_version
      ) SELECT blockface_key, borough, on_street, from_street, to_street, NULL,
        NULL, NULL, NULL, $3, ST_GeomFromText(geom_wkt, 4326), now(),
        $1, $2, false, 'parking-rules-v3-public-reference'
      FROM geometry_stage
      ON CONFLICT (blockface_key) DO UPDATE SET
        borough = EXCLUDED.borough, on_street = EXCLUDED.on_street,
        from_street = EXCLUDED.from_street, to_street = EXCLUDED.to_street,
        side_of_street = NULL, source = EXCLUDED.source, geom = EXCLUDED.geom,
        updated_at = now(), source_run_id = EXCLUDED.source_run_id,
        source_updated_at = EXCLUDED.source_updated_at, geometry_validated = false,
        interpretation_version = EXCLUDED.interpretation_version
      WHERE curb_segments.source = $3
    `, [run.id, run.sourceUpdatedAt, `geometry:${config.nycGeometryDatasetId}`]);
    await publishIngestionRun(client, run, keys.size, snapshotChecksum(keys), {
      partial: hitPageLimit,
      pages: page,
      skippedDuplicates,
      geometryValidated: false,
      safetyNote: "Street Pavement Ratings is retained only as unvalidated context geometry."
    });
    await client.query("COMMIT");
    console.log(`[ingest:geometry] published run=${run.id} rows=${keys.size} partial=${hitPageLimit}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await failIngestionRun(run, error);
    throw error;
  } finally {
    await client.query("DROP TABLE IF EXISTS geometry_stage").catch(() => undefined);
    client.release();
  }
}

if (require.main === module) {
  ingestGeometry().then(async () => { await pool.end(); process.exit(0); })
    .catch(async error => { console.error("[ingest:geometry] failed", error); await pool.end(); process.exit(1); });
}
