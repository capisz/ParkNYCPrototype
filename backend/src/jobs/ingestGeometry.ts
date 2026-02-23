import { createHash } from "crypto";
import { pool } from "../db";
import { config } from "../config";
import { buildBlockfaceKey, isBlockfaceKeyUsable } from "../lib/blockface";
import { fetchSocrataRows } from "../lib/socrata";

type Coord = [number, number];

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDateOrNull(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function extractLongestLine(geom: unknown): Coord[] | null {
  if (!geom || typeof geom !== "object") return null;
  const maybe = geom as { type?: string; coordinates?: unknown };
  if (!Array.isArray(maybe.coordinates)) return null;

  if (maybe.type === "LineString") {
    const line = maybe.coordinates
      .map((pair) => (Array.isArray(pair) && pair.length >= 2 ? [Number(pair[0]), Number(pair[1])] : null))
      .filter((pair): pair is Coord => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
    return line.length >= 2 ? line : null;
  }

  const multi = maybe.coordinates as unknown[];
  let best: Coord[] = [];
  for (const lineUnknown of multi) {
    if (!Array.isArray(lineUnknown)) continue;
    const line = lineUnknown
      .map((pair) => (Array.isArray(pair) && pair.length >= 2 ? [Number(pair[0]), Number(pair[1])] : null))
      .filter((pair): pair is Coord => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
    if (line.length > best.length) best = line;
  }
  return best.length >= 2 ? best : null;
}

function lineToWkt(coords: Coord[]): string {
  const points = coords.map(([lon, lat]) => `${lon} ${lat}`).join(", ");
  return `LINESTRING(${points})`;
}

function shaPayload(input: unknown): string {
  const normalized = JSON.stringify(input) ?? "";
  return createHash("sha1").update(normalized).digest("hex");
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
  const client = await pool.connect();
  const seenGeometryKeys = new Set<string>();
  const pageLimit = Math.max(1000, config.nycGeometryPageLimit);

  try {
    const select = [
      "distinct oftcode",
      "boroughname",
      "onstreetna",
      "fromstreet",
      "tostreetna",
      "the_geom"
    ].join(",");

    let total = 0;
    let page = 0;
    let offset = 0;
    let skippedDuplicates = 0;

    while (true) {
      if (config.nycMaxPages > 0 && page >= config.nycMaxPages) break;

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

      await client.query("BEGIN");
      try {
        for (const row of rows) {
          const geometryKey = asString(row.oftcode);
          if (!geometryKey) continue;
          if (seenGeometryKeys.has(geometryKey)) {
            skippedDuplicates += 1;
            continue;
          }
          seenGeometryKeys.add(geometryKey);

          const borough = canonicalBorough(asString(row.boroughname));
          const onStreet = asString(row.onstreetna);
          const fromStreet = asString(row.fromstreet);
          const toStreet = asString(row.tostreetna);

          const blockfaceKey = buildBlockfaceKey({
            borough,
            onStreet,
            fromStreet,
            toStreet,
            sideOfStreet: `SEG-${geometryKey}`
          });

          if (!isBlockfaceKeyUsable(blockfaceKey)) continue;

          const coords = extractLongestLine(row.the_geom);
          if (!coords) continue;
          const geomWkt = lineToWkt(coords);

          const sourceUpdatedAt = null;
          const payloadHash = shaPayload(row);

          await client.query(
            `
            INSERT INTO street_geometry_raw (
              geometry_key,
              blockface_key,
              borough,
              on_street,
              from_street,
              to_street,
              source_updated_at,
              payload,
              ingested_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now())
            ON CONFLICT (geometry_key) DO UPDATE SET
              blockface_key = EXCLUDED.blockface_key,
              borough = EXCLUDED.borough,
              on_street = EXCLUDED.on_street,
              from_street = EXCLUDED.from_street,
              to_street = EXCLUDED.to_street,
              source_updated_at = EXCLUDED.source_updated_at,
              payload = EXCLUDED.payload,
              ingested_at = now()
            `,
            [
              geometryKey,
              blockfaceKey,
              borough,
              onStreet,
              fromStreet,
              toStreet,
              sourceUpdatedAt,
              JSON.stringify({ ...row, _payload_hash: payloadHash })
            ]
          );

          await client.query(
            `
            INSERT INTO curb_segments (
              blockface_key,
              borough,
              on_street,
              from_street,
              to_street,
              side_of_street,
              meter_rate,
              paid_hours,
              pay_by_cell,
              source,
              geom,
              updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              ST_GeomFromText($11, 4326),
              now()
            )
            ON CONFLICT (blockface_key) DO UPDATE SET
              borough = EXCLUDED.borough,
              on_street = EXCLUDED.on_street,
              from_street = EXCLUDED.from_street,
              to_street = EXCLUDED.to_street,
              side_of_street = EXCLUDED.side_of_street,
              source = EXCLUDED.source,
              geom = EXCLUDED.geom,
              updated_at = now()
            `,
            [
              blockfaceKey,
              borough,
              onStreet,
              fromStreet,
              toStreet,
              null,
              null,
              null,
              null,
              `geometry:${config.nycGeometryDatasetId}`,
              geomWkt
            ]
          );

          total += 1;
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      offset += rows.length;
      console.log(
        `[ingest:geometry] page=${page} rows=${rows.length} upserts=${total} skipped_duplicates=${skippedDuplicates}`
      );
      if (rows.length < pageLimit) break;
    }

    console.log(
      `[ingest:geometry] complete. processed=${total} skipped_duplicates=${skippedDuplicates} unique_geometry_keys=${seenGeometryKeys.size}`
    );
  } finally {
    client.release();
  }
}

if (require.main === module) {
  ingestGeometry()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("[ingest:geometry] failed", error);
      await pool.end();
      process.exit(1);
    });
}
