import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db";

const integration = describe.runIf(process.env.RUN_DB_INTEGRATION === "true");

integration("snapshot publication with Postgres/PostGIS", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("removes facility records absent from a successful staged snapshot", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{ id: string }>(`
        INSERT INTO ingestion_runs (dataset_key, source_dataset_id, status, source_updated_at)
        VALUES ('facilities', 'integration-test', 'running', now()) RETURNING id::text
      `);
      await client.query(`
        INSERT INTO licensed_facilities (
          license_number, legal_name, address, license_status, geom, payload,
          source_run_id, source_updated_at
        ) VALUES
          ('KEEP-INTEGRATION', 'Keep Garage', '1 Test Street', 'Active',
            ST_SetSRID(ST_MakePoint(-73.98, 40.75), 4326), '{}'::jsonb, $1, now()),
          ('DELETE-INTEGRATION', 'Deleted Garage', '2 Test Street', 'Active',
            ST_SetSRID(ST_MakePoint(-73.99, 40.76), 4326), '{}'::jsonb, $1, now())
      `, [run.rows[0].id]);
      await client.query("CREATE TEMP TABLE facilities_stage (license_number text PRIMARY KEY)");
      await client.query("INSERT INTO facilities_stage VALUES ('KEEP-INTEGRATION')");
      await client.query(`
        DELETE FROM licensed_facilities current
        WHERE NOT EXISTS (
          SELECT 1 FROM facilities_stage stage WHERE stage.license_number = current.license_number
        )
      `);
      const remaining = await client.query<{ license_number: string }>(`
        SELECT license_number FROM licensed_facilities
        WHERE license_number LIKE '%-INTEGRATION' ORDER BY license_number
      `);
      expect(remaining.rows.map(row => row.license_number)).toEqual(["KEEP-INTEGRATION"]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps the prior published run active when a replacement fails", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const published = await client.query<{ id: string }>(`
        INSERT INTO ingestion_runs (
          dataset_key, source_dataset_id, status, completed_at, published_at, source_updated_at, row_count
        ) VALUES ('facilities-integration', 'integration-test', 'published', now(), now(), now(), 2)
        RETURNING id::text
      `);
      const failed = await client.query<{ id: string }>(`
        INSERT INTO ingestion_runs (dataset_key, source_dataset_id, status, source_updated_at)
        VALUES ('facilities-integration', 'integration-test', 'running', now()) RETURNING id::text
      `);
      await client.query(`
        UPDATE ingestion_runs SET status = 'failed', completed_at = now()
        WHERE id = $1
      `, [failed.rows[0].id]);
      const active = await client.query<{ id: string }>(`
        SELECT id::text FROM ingestion_runs
        WHERE dataset_key = 'facilities-integration' AND status = 'published'
      `);
      expect(active.rows).toEqual([{ id: published.rows[0].id }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
