import { pool } from "../db";
import { config } from "../config";
import { parseParkingRules, ParsedRule } from "../lib/parkingRuleParser";

type SegmentEvidence = {
  id: string;
  paid_hours: string | null;
  has_meter: boolean;
  signs: SignEvidence[] | null;
};

type SignEvidence = {
  description: string;
  arrowDirection: string | null;
  distanceFromIntersection: number | null;
  xCoord: number | null;
  yCoord: number | null;
};

type RuleInsert = ParsedRule & { segmentId: string };

const PUBLIC_DATA_FREE_REFERENCE_SOURCE = "nyc-sign-meter-free-reference";
const PUBLIC_DATA_ASSUMED_FREE_SOURCE = "nyc-sign-assumed-free-reference";

/**
 * These are informational companions to a regulatory sign, not independent
 * curb rules. Treating them as unresolved parking rules made nearly every
 * ParkNYC blockface gray even when its actual regulation signs were parsed.
 */
function isInformationalSignPanel(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim().toUpperCase();
  return /\bPAY-BY-(?:CELL|APP)\b/.test(text) ||
    /\bLOCATOR NUMBER\b/.test(text) ||
    /\bMTA BUS (?:ROUTE|DESTINATION) PANEL\b/.test(text) ||
    /\bSELECT BUS SERVICE (?:ROUTE|DESTINATION) PANEL\b/.test(text) ||
    /\bLOCATION PANEL\b/.test(text) ||
    /\bREAL TIME PUBLIC INFORMATION BOX\b/.test(text) ||
    /\bMETERS? (?:ARE|IS) NOT IN EFFECT ABOVE TIMES\b/.test(text);
}

function parserTextForSign(sign: SignEvidence): { text: string; directionalReference: boolean } {
  const description = sign.description.replace(/\s+/g, " ").trim();
  const asciiArrow = /(?:<-{1,8}>|-{1,8}>|<-{1,8})/;
  const hasDirectionalPanel = /\b(?:SINGLE|DOUBLE)\s+ARROWS?\b/i.test(description) ||
    asciiArrow.test(description);
  if (!hasDirectionalPanel) return { text: description, directionalReference: false };

  const hasResolvedDirection = /\bDOUBLE\s+ARROWS?\b/i.test(description) ||
    /<-{1,8}>/.test(description) || Boolean(sign.arrowDirection);
  if (!hasResolvedDirection) return { text: description, directionalReference: false };
  return {
    text: description
      .replace(/\(?\b(?:SINGLE|DOUBLE)\s+ARROWS?\b\)?/gi, " ")
      .replace(/(?:<-{1,8}>|-{1,8}>|<-{1,8})/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    directionalReference: true
  };
}

function rulesForSign(sign: SignEvidence): ParsedRule[] {
  const parserInput = parserTextForSign(sign);
  return parseParkingRules(parserInput.text, "nyc-signs").map(rule => ({
    ...rule,
    reason: parserInput.directionalReference
      ? `${sign.description} Directional extent is conservatively applied to the full blockface reference.`
      : rule.reason
  }));
}

function rulesForSegment(row: SegmentEvidence): RuleInsert[] {
  const regulatorySigns = (row.signs ?? []).filter(sign => !isInformationalSignPanel(sign.description));
  const signRules = regulatorySigns.flatMap(rulesForSign);
  const parsed = signRules
    // ParkNYC supplies the canonical paid schedule for meter blockfaces. Keep
    // the linked sign in the completeness gate, but do not persist a duplicate
    // paid rule that could conflict with Sunday/holiday meter suspension.
    .filter(rule => rule.status !== "unknown" && !(row.has_meter && rule.status === "paid"))
    .map(rule => ({ ...rule, segmentId: row.id }));

  const hasUnresolvedRegulatorySign = signRules.some(rule => rule.status === "unknown");
  if (hasUnresolvedRegulatorySign) {
    parsed.push({
      segmentId: row.id, status: "unknown", dayMask: 127, startMinute: 0,
      endMinute: 1440, confidence: 0.2,
      reason: "One or more linked regulatory signs could not be resolved into a reliable schedule.",
      source: "nyc-signs"
    });
  }

  let hasRecognizedMeterSchedule = false;
  if (row.has_meter) {
    const meterRules = parseParkingRules(`METER ${row.paid_hours ?? ""}`, "nyc-meters")
      .filter(rule => rule.status === "paid");
    if (meterRules.length > 0) {
      hasRecognizedMeterSchedule = true;
      parsed.push(...meterRules.map(meter => ({
        ...meter, segmentId: row.id, status: "paid" as const,
        confidence: Math.max(meter.confidence, 0.78),
        reason: `Metered parking during ${row.paid_hours}.`
      })));
    } else parsed.push({
      segmentId: row.id, status: "unknown", dayMask: 127, startMinute: 0,
      endMinute: 1440, confidence: 0.2,
      reason: row.paid_hours
        ? `Metered parking during ${row.paid_hours}.`
        : "NYC meter data confirms a meter, but its operating hours were unavailable.",
      source: "nyc-meters"
    });
  }

  // This is an explicit all-day baseline, not an inference made at request
  // time from a missing active rule. More restrictive recognized sign and
  // meter windows still win in the interval classifier. Any unresolved linked
  // regulatory sign prevents the baseline from being published.
  const evidenceComplete = regulatorySigns.length > 0 && !hasUnresolvedRegulatorySign &&
    (!row.has_meter || hasRecognizedMeterSchedule);
  if (evidenceComplete) {
    parsed.push({
      segmentId: row.id,
      status: "free",
      dayMask: 127,
      startMinute: 0,
      endMinute: 1440,
      confidence: row.has_meter ? 0.65 : 0.6,
      reason: row.has_meter
        ? "Current linked NYC sign records and the ParkNYC meter schedule fully resolve this blockface; no payment or recognized prohibition is active outside their scheduled windows."
        : "Current linked NYC sign records fully resolve this blockface; no meter or recognized prohibition is active outside their scheduled windows.",
      source: row.has_meter ? PUBLIC_DATA_FREE_REFERENCE_SOURCE : PUBLIC_DATA_ASSUMED_FREE_SOURCE
    });
  }

  if (parsed.length === 0) {
    parsed.push({
      segmentId: row.id, status: "unknown", dayMask: 127, startMinute: 0,
      endMinute: 1440, confidence: 0.2,
      reason: "No recognized time-bounded parking rule matched this curb.",
      source: "conservative-fallback"
    });
  }

  return parsed.filter((rule, index, all) => all.findIndex(other =>
    other.status === rule.status && other.dayMask === rule.dayMask &&
    other.startMinute === rule.startMinute && other.endMinute === rule.endMinute &&
    other.reason === rule.reason
  ) === index);
}

async function insertRules(client: import("pg").PoolClient, rules: RuleInsert[]): Promise<void> {
  for (let offset = 0; offset < rules.length; offset += 1000) {
    const batch = rules.slice(offset, offset + 1000);
    await client.query(`
      INSERT INTO curb_rules (
        curb_segment_id, status, day_mask, start_minute, end_minute,
        confidence, reason, source, updated_at
      )
      SELECT * FROM UNNEST(
        $1::uuid[], $2::text[], $3::int[], $4::int[], $5::int[],
        $6::numeric[], $7::text[], $8::text[], $9::timestamptz[]
      )
    `, [
      batch.map(r => r.segmentId), batch.map(r => r.status), batch.map(r => r.dayMask),
      batch.map(r => r.startMinute), batch.map(r => r.endMinute), batch.map(r => r.confidence),
      batch.map(r => r.reason), batch.map(r => r.source), batch.map(() => new Date())
    ]);
  }
}

export async function rebuildRules(): Promise<void> {
  const client = await pool.connect();
  try {
    const evidence = await client.query<SegmentEvidence>(`
      WITH segment_keys AS (
        SELECT s.id, s.paid_hours, s.blockface_key, blockface_key4(s.blockface_key) AS key4,
          split_part(s.blockface_key, '|', 1) || '|' || split_part(s.blockface_key, '|', 2) || '|' ||
          split_part(s.blockface_key, '|', 4) || '|' || split_part(s.blockface_key, '|', 3) AS key4_rev
        FROM curb_segments s
        WHERE s.geometry_validated = true OR s.source = $1
      )
      SELECT sk.id::text, sk.paid_hours,
        COALESCE(m.has_meter, false) AS has_meter,
        COALESCE(ps.signs, '[]'::jsonb) AS signs
      FROM segment_keys sk
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(DISTINCT jsonb_build_object(
          'description', sign_description,
          'arrowDirection', arrow_direction,
          'distanceFromIntersection', distance_from_intersection,
          'xCoord', sign_x_coord,
          'yCoord', sign_y_coord
        )) FILTER (WHERE sign_description IS NOT NULL) AS signs
        FROM parking_signs_raw
        WHERE blockface_key = sk.blockface_key OR blockface_key4(blockface_key) = sk.key4
          OR blockface_key4(blockface_key) = sk.key4_rev
      ) ps ON true
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM meter_blockfaces_raw
          WHERE blockface_key = sk.blockface_key OR blockface_key4(blockface_key) = sk.key4
            OR blockface_key4(blockface_key) = sk.key4_rev
        ) AS has_meter
      ) m ON true
    `, [`meters:${config.nycMeterDatasetId}`]);

    const rules = evidence.rows.flatMap(rulesForSegment);
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE curb_rules");
    await insertRules(client, rules);
    await client.query("UPDATE curb_segments SET interpretation_version = 'parking-rules-v4-assumed-free', updated_at = now()");
    await client.query("COMMIT");
    console.log(`[ingest:rules] complete. segments=${evidence.rowCount ?? 0} rules=${rules.length}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  rebuildRules().then(async () => { await pool.end(); process.exit(0); })
    .catch(async error => { console.error("[ingest:rules] failed", error); await pool.end(); process.exit(1); });
}

export const rebuildRulesInternals = {
  isInformationalSignPanel,
  rulesForSegment,
  parserTextForSign,
  PUBLIC_DATA_FREE_REFERENCE_SOURCE,
  PUBLIC_DATA_ASSUMED_FREE_SOURCE
};
