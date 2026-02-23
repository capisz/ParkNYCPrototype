import { pool } from "../db";

export async function rebuildRules(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("TRUNCATE TABLE curb_rules");

    await client.query(
      `
      INSERT INTO curb_rules (
        curb_segment_id,
        status,
        day_mask,
        start_minute,
        end_minute,
        confidence,
        reason,
        source,
        updated_at
      )
      WITH segment_keys AS (
        SELECT
          s.id,
          s.blockface_key,
          blockface_key4(s.blockface_key) AS key4,
          split_part(s.blockface_key, '|', 1) || '|' ||
          split_part(s.blockface_key, '|', 2) || '|' ||
          split_part(s.blockface_key, '|', 4) || '|' ||
          split_part(s.blockface_key, '|', 3) AS key4_rev
        FROM curb_segments s
      ),
      sign_matches AS (
        SELECT
          sk.id,
          COALESCE(
            BOOL_OR(
              ps.sign_description ILIKE '%NO PARKING%'
              OR ps.sign_description ILIKE '%NO STANDING%'
              OR ps.sign_description ILIKE '%NO STOPPING%'
            ),
            false
          ) AS has_no_parking,
          COALESCE(
            BOOL_OR(
              ps.sign_description ILIKE '%METER%'
              OR ps.sign_description ILIKE '%PAY%'
            ),
            false
          ) AS has_payment,
          COALESCE(BOOL_OR(ps.sign_description ILIKE '%PARKING%'), false) AS has_parking
        FROM segment_keys sk
        LEFT JOIN parking_signs_raw ps
          ON ps.blockface_key = sk.blockface_key
          OR blockface_key4(ps.blockface_key) = sk.key4
          OR blockface_key4(ps.blockface_key) = sk.key4_rev
        GROUP BY sk.id
      ),
      meter_matches AS (
        SELECT
          sk.id,
          COALESCE(BOOL_OR(m.blockface_key IS NOT NULL), false) AS has_meter
        FROM segment_keys sk
        LEFT JOIN meter_blockfaces_raw m
          ON m.blockface_key = sk.blockface_key
          OR blockface_key4(m.blockface_key) = sk.key4
          OR blockface_key4(m.blockface_key) = sk.key4_rev
        GROUP BY sk.id
      )
      SELECT
        s.id,
        CASE
          WHEN mm.has_meter THEN 'paid'
          WHEN sm.has_no_parking AND NOT sm.has_payment AND NOT sm.has_parking THEN 'no_parking'
          WHEN sm.has_payment THEN 'paid'
          WHEN sm.has_parking THEN 'free'
          ELSE 'unknown'
        END AS status,
        127,
        0,
        1440,
        CASE
          WHEN mm.has_meter THEN 0.78
          WHEN sm.has_no_parking AND NOT sm.has_payment AND NOT sm.has_parking THEN 0.70
          WHEN sm.has_payment THEN 0.66
          WHEN sm.has_parking THEN 0.55
          ELSE 0.30
        END AS confidence,
        CASE
          WHEN mm.has_meter THEN 'Meter blockface data indicates paid parking.'
          WHEN sm.has_no_parking AND NOT sm.has_payment AND NOT sm.has_parking THEN 'Sign text indicates active restriction.'
          WHEN sm.has_payment THEN 'Sign text indicates payment requirement.'
          WHEN sm.has_parking THEN 'Sign text indicates parking allowed with caveats.'
          ELSE 'No rule match from ingested sources.'
        END AS reason,
        'heuristic-v2',
        now()
      FROM curb_segments s
      LEFT JOIN sign_matches sm ON sm.id = s.id
      LEFT JOIN meter_matches mm ON mm.id = s.id
      `
    );

    await client.query("COMMIT");

    const countResult = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM curb_rules");
    console.log(`[ingest:rules] complete. rules=${countResult.rows[0]?.count ?? "0"}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  rebuildRules()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("[ingest:rules] failed", error);
      await pool.end();
      process.exit(1);
    });
}
