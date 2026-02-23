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

export async function ingestMeters(): Promise<void> {
  const client = await pool.connect();
  try {
    const select = [
      "the_geom",
      "pay_by_cel",
      "all_vehi_1",
      "meter_rate",
      "on_street",
      "side_of_st",
      "from_stree",
      "to_street",
      "borough"
    ].join(",");

    let total = 0;
    let page = 0;
    let offset = 0;

    while (true) {
      if (config.nycMaxPages > 0 && page >= config.nycMaxPages) break;

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

      await client.query("BEGIN");
      try {
        for (const row of rows) {
          const blockfaceKey = buildBlockfaceKey({
            borough: asString(row.borough),
            onStreet: asString(row.on_street),
            fromStreet: asString(row.from_stree),
            toStreet: asString(row.to_street),
            sideOfStreet: asString(row.side_of_st)
          });

          if (!isBlockfaceKeyUsable(blockfaceKey)) continue;

          const coords = extractLongestLine(row.the_geom);
          if (!coords) continue;

          const geomWkt = lineToWkt(coords);
          const payload = row;
          const payloadHash = shaPayload(payload);

          await client.query(
            `
            INSERT INTO meter_blockfaces_raw (
              blockface_key,
              borough,
              on_street,
              from_street,
              to_street,
              side_of_street,
              meter_rate,
              paid_hours,
              pay_by_cell,
              payload,
              ingested_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())
            ON CONFLICT (blockface_key) DO UPDATE SET
              borough = EXCLUDED.borough,
              on_street = EXCLUDED.on_street,
              from_street = EXCLUDED.from_street,
              to_street = EXCLUDED.to_street,
              side_of_street = EXCLUDED.side_of_street,
              meter_rate = EXCLUDED.meter_rate,
              paid_hours = EXCLUDED.paid_hours,
              pay_by_cell = EXCLUDED.pay_by_cell,
              payload = EXCLUDED.payload,
              ingested_at = now()
            `,
            [
              blockfaceKey,
              asString(row.borough),
              asString(row.on_street),
              asString(row.from_stree),
              asString(row.to_street),
              asString(row.side_of_st),
              asString(row.meter_rate),
              asString(row.all_vehi_1),
              asString(row.pay_by_cel),
              JSON.stringify({ ...payload, _payload_hash: payloadHash })
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
              meter_rate = EXCLUDED.meter_rate,
              paid_hours = EXCLUDED.paid_hours,
              pay_by_cell = EXCLUDED.pay_by_cell,
              source = EXCLUDED.source,
              geom = EXCLUDED.geom,
              updated_at = now()
            `,
            [
              blockfaceKey,
              asString(row.borough),
              asString(row.on_street),
              asString(row.from_stree),
              asString(row.to_street),
              asString(row.side_of_st),
              asString(row.meter_rate),
              asString(row.all_vehi_1),
              asString(row.pay_by_cel),
              `meters:${config.nycMeterDatasetId}`,
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
      console.log(`[ingest:meters] page=${page} rows=${rows.length} upserts=${total}`);

      if (rows.length < config.nycPageLimit) break;
    }

    console.log(`[ingest:meters] complete. processed=${total}`);
  } finally {
    client.release();
  }
}

if (require.main === module) {
  ingestMeters()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("[ingest:meters] failed", error);
      await pool.end();
      process.exit(1);
    });
}
