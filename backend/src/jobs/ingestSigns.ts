import { createHash } from "crypto";
import { pool } from "../db";
import { config } from "../config";
import { buildBlockfaceKey, isBlockfaceKeyUsable } from "../lib/blockface";
import { fetchSocrataRows } from "../lib/socrata";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDateOrNull(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function buildFingerprint(input: {
  blockfaceKey: string;
  orderNumber: string | null;
  signCode: string | null;
  signDescription: string | null;
  recordType: string | null;
}): string {
  const base = [
    input.blockfaceKey,
    input.orderNumber ?? "",
    input.signCode ?? "",
    input.signDescription ?? "",
    input.recordType ?? ""
  ].join("|");
  return createHash("sha1").update(base).digest("hex");
}

export async function ingestSigns(): Promise<void> {
  const client = await pool.connect();
  try {
    const select = [
      "order_number",
      "record_type",
      "borough",
      "on_street",
      "from_street",
      "to_street",
      "side_of_street",
      "order_completed_on_date",
      "sign_code",
      "sign_description"
    ].join(",");

    let total = 0;
    let page = 0;
    let offset = 0;

    while (true) {
      if (config.nycMaxPages > 0 && page >= config.nycMaxPages) break;

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

      await client.query("BEGIN");
      try {
        for (const row of rows) {
          const blockfaceKey = buildBlockfaceKey({
            borough: asString(row.borough),
            onStreet: asString(row.on_street),
            fromStreet: asString(row.from_street),
            toStreet: asString(row.to_street),
            sideOfStreet: asString(row.side_of_street)
          });

          if (!isBlockfaceKeyUsable(blockfaceKey)) continue;

          const orderNumber = asString(row.order_number);
          const signCode = asString(row.sign_code);
          const signDescription = asString(row.sign_description);
          const recordType = asString(row.record_type);
          const completedDate = toDateOrNull(asString(row.order_completed_on_date));
          const fingerprint = buildFingerprint({
            blockfaceKey,
            orderNumber,
            signCode,
            signDescription,
            recordType
          });

          await client.query(
            `
            INSERT INTO parking_signs_raw (
              fingerprint,
              blockface_key,
              order_number,
              record_type,
              sign_code,
              sign_description,
              order_completed_on_date,
              payload,
              ingested_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now())
            ON CONFLICT (fingerprint) DO UPDATE SET
              blockface_key = EXCLUDED.blockface_key,
              order_number = EXCLUDED.order_number,
              record_type = EXCLUDED.record_type,
              sign_code = EXCLUDED.sign_code,
              sign_description = EXCLUDED.sign_description,
              order_completed_on_date = EXCLUDED.order_completed_on_date,
              payload = EXCLUDED.payload,
              ingested_at = now()
            `,
            [
              fingerprint,
              blockfaceKey,
              orderNumber,
              recordType,
              signCode,
              signDescription,
              completedDate,
              JSON.stringify(row)
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
      console.log(`[ingest:signs] page=${page} rows=${rows.length} upserts=${total}`);

      if (rows.length < config.nycPageLimit) break;
    }

    console.log(`[ingest:signs] complete. processed=${total}`);
  } finally {
    client.release();
  }
}

if (require.main === module) {
  ingestSigns()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("[ingest:signs] failed", error);
      await pool.end();
      process.exit(1);
    });
}
