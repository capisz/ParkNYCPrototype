import { pool } from "../db";
import { config } from "../config";
import {
  failIngestionRun,
  publishIngestionRun,
  snapshotChecksum,
  startIngestionRun
} from "../lib/ingestionRun";
import { fetchSocrataRows } from "../lib/socrata";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asCoordinate(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDate(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export async function ingestFacilities(): Promise<void> {
  const run = await startIngestionRun("facilities", config.nycGarageDatasetId);
  const client = await pool.connect();
  const keys = new Set<string>();
  let page = 0;
  let offset = 0;
  let hitPageLimit = false;

  try {
    await client.query(`
      CREATE TEMP TABLE facilities_stage (
        license_number TEXT PRIMARY KEY,
        legal_name TEXT NOT NULL,
        dba_name TEXT,
        address TEXT NOT NULL,
        phone TEXT,
        license_status TEXT NOT NULL,
        license_expires_at DATE,
        facility_details TEXT,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        payload JSONB NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);

    const select = [
      "license_nbr", "business_name", "dba_trade_name", "business_category", "license_status",
      "lic_expir_dd", "detail", "contact_phone", "address_building", "address_street_name",
      "address_city", "address_state", "address_zip", "latitude", "longitude"
    ].join(",");

    while (true) {
      if (config.nycMaxPages > 0 && page >= config.nycMaxPages) {
        hitPageLimit = true;
        break;
      }
      const rows = await fetchSocrataRows({
        datasetId: config.nycGarageDatasetId,
        select,
        where: "business_category='Garage & Parking Lot' AND license_status='Active'",
        orderBy: "license_nbr",
        offset,
        limit: config.nycPageLimit
      });
      if (rows.length === 0) break;
      page += 1;

      for (const row of rows) {
        if (asString(row.business_category) !== "Garage & Parking Lot" || asString(row.license_status) !== "Active") {
          throw new Error("DCWP facility snapshot contained a row outside the required active garage/parking-lot filter.");
        }
        const licenseNumber = asString(row.license_nbr);
        const legalName = asString(row.business_name);
        const latitude = asCoordinate(row.latitude);
        const longitude = asCoordinate(row.longitude);
        const address = [
          row.address_building, row.address_street_name, row.address_city, row.address_state, row.address_zip
        ].map(asString).filter((value): value is string => value != null).join(" ");
        if (!licenseNumber || !legalName || !address || latitude == null || longitude == null) continue;
        if (latitude < 40 || latitude > 41.5 || longitude < -75 || longitude > -73) continue;
        keys.add(licenseNumber);
        await client.query(`
          INSERT INTO facilities_stage (
            license_number, legal_name, dba_name, address, phone, license_status,
            license_expires_at, facility_details, latitude, longitude, payload
          ) VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,$8,$9,$10::jsonb)
          ON CONFLICT (license_number) DO UPDATE SET
            legal_name = EXCLUDED.legal_name, dba_name = EXCLUDED.dba_name,
            address = EXCLUDED.address, phone = EXCLUDED.phone,
            license_status = EXCLUDED.license_status,
            license_expires_at = EXCLUDED.license_expires_at,
            facility_details = EXCLUDED.facility_details,
            latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
            payload = EXCLUDED.payload
        `, [
          licenseNumber, legalName, asString(row.dba_trade_name), address,
          asString(row.contact_phone), asDate(row.lic_expir_dd), asString(row.detail),
          latitude, longitude, JSON.stringify(row)
        ]);
      }
      offset += rows.length;
      console.log(`[ingest:facilities] staged page=${page} rows=${rows.length} unique=${keys.size}`);
      if (rows.length < config.nycPageLimit) break;
    }

    if (hitPageLimit && !config.allowPartialIngest) {
      throw new Error("Refusing to publish a partial facility snapshot. Remove NYC_MAX_PAGES or explicitly allow a partial development ingest.");
    }
    if (keys.size === 0) {
      throw new Error("Refusing to publish an empty active-facility snapshot.");
    }

    await client.query("BEGIN");
    if (!hitPageLimit) {
      await client.query(`
        DELETE FROM licensed_facilities current
        WHERE NOT EXISTS (
          SELECT 1 FROM facilities_stage stage WHERE stage.license_number = current.license_number
        )
      `);
    }
    await client.query(`
      INSERT INTO licensed_facilities (
        license_number, legal_name, dba_name, address, phone, license_status,
        license_expires_at, facility_details, geom, payload, source_run_id,
        source_updated_at, published_at
      ) SELECT license_number, legal_name, dba_name, address, phone, license_status,
        license_expires_at, facility_details,
        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326), payload, $1, $2, now()
      FROM facilities_stage
      ON CONFLICT (license_number) DO UPDATE SET
        legal_name = EXCLUDED.legal_name, dba_name = EXCLUDED.dba_name,
        address = EXCLUDED.address, phone = EXCLUDED.phone,
        license_status = EXCLUDED.license_status,
        license_expires_at = EXCLUDED.license_expires_at,
        facility_details = EXCLUDED.facility_details,
        geom = EXCLUDED.geom, payload = EXCLUDED.payload,
        source_run_id = EXCLUDED.source_run_id,
        source_updated_at = EXCLUDED.source_updated_at,
        published_at = now()
    `, [run.id, run.sourceUpdatedAt]);
    await publishIngestionRun(client, run, keys.size, snapshotChecksum(keys), {
      partial: hitPageLimit,
      pages: page,
      filters: ["business_category=Garage & Parking Lot", "license_status=Active"]
    });
    await client.query("COMMIT");
    console.log(`[ingest:facilities] published run=${run.id} rows=${keys.size} partial=${hitPageLimit}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await failIngestionRun(run, error);
    throw error;
  } finally {
    await client.query("DROP TABLE IF EXISTS facilities_stage").catch(() => undefined);
    client.release();
  }
}

if (require.main === module) {
  ingestFacilities().then(async () => { await pool.end(); process.exit(0); })
    .catch(async error => { console.error("[ingest:facilities] failed", error); await pool.end(); process.exit(1); });
}
