import { config } from "../config";
import { dbQuery } from "../db";

type ParkingStatus = "free" | "paid" | "no_parking" | "unknown";

type LocalTimeWindow = {
  weekday: string;
  minuteOfDay: number;
  dayBit: number;
};

type ViewportInput = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  asOf?: Date;
};

type DbViewportRow = {
  segment_id: string;
  blockface_key: string;
  on_street: string | null;
  from_street: string | null;
  to_street: string | null;
  side_of_street: string | null;
  paid_hours: string | null;
  meter_rate: string | null;
  status: string | null;
  confidence: number | string | null;
  reason: string | null;
  geometry: unknown;
  total_count: number;
};

type LineStringGeometry = {
  type: "LineString" | "MultiLineString";
  coordinates: unknown;
};

type ViewportFeature = {
  type: "Feature";
  id: string;
  geometry: LineStringGeometry;
  properties: {
    blockfaceKey: string;
    status: ParkingStatus;
    color: string;
    confidence: number;
    reason: string | null;
    onStreet: string | null;
    fromStreet: string | null;
    toStreet: string | null;
    sideOfStreet: string | null;
    paidHours: string | null;
    meterRate: string | null;
  };
};

type ViewportSummary = {
  noParking: number;
  paid: number;
  free: number;
  unknown: number;
};

export type ViewportResponse = {
  type: "FeatureCollection";
  generatedAt: string;
  asOf: string;
  timezone: string;
  totalMatched: number;
  returned: number;
  clipped: boolean;
  summary: ViewportSummary;
  features: ViewportFeature[];
};

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

function getLocalTimeWindow(asOf: Date, timezone: string): LocalTimeWindow {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  });

  const parts = formatter.formatToParts(asOf);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hourText = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minuteText = parts.find((part) => part.type === "minute")?.value ?? "00";
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const minuteOfDay = Math.max(0, Math.min(1439, hour * 60 + minute));
  const dayIdx = DAY_INDEX[weekday] ?? 0;
  const dayBit = 1 << dayIdx;

  return { weekday, minuteOfDay, dayBit };
}

function normalizeStatus(raw: string | null | undefined): ParkingStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "free":
      return "free";
    case "paid":
      return "paid";
    case "no_parking":
      return "no_parking";
    default:
      return "unknown";
  }
}

function statusColor(status: ParkingStatus): string {
  switch (status) {
    case "no_parking":
      return "#D64545";
    case "paid":
      return "#E6B422";
    case "free":
      return "#2EAD63";
    default:
      return "#8D93A6";
  }
}

function parseConfidence(value: number | string | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0.25;
}

function parseGeometry(value: unknown): LineStringGeometry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { type?: unknown; coordinates?: unknown };
  if (
    (candidate.type === "LineString" || candidate.type === "MultiLineString") &&
    candidate.coordinates !== undefined
  ) {
    return {
      type: candidate.type,
      coordinates: candidate.coordinates
    };
  }
  return null;
}

export async function getViewportParking(input: ViewportInput): Promise<ViewportResponse> {
  const asOf = input.asOf ?? new Date();
  const window = getLocalTimeWindow(asOf, config.timezone);

  const result = await dbQuery<DbViewportRow>(
    `
    WITH bbox AS (
      SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS geom
    ),
    candidates AS (
      SELECT
        s.id,
        s.blockface_key,
        s.on_street,
        s.from_street,
        s.to_street,
        s.side_of_street,
        s.paid_hours,
        s.meter_rate,
        s.geom
      FROM curb_segments s
      JOIN bbox b ON ST_Intersects(s.geom, b.geom)
    ),
    active_rules AS (
      SELECT
        c.id AS curb_segment_id,
        r.status,
        r.confidence,
        r.reason,
        ROW_NUMBER() OVER (
          PARTITION BY c.id
          ORDER BY
            CASE r.status
              WHEN 'no_parking' THEN 4
              WHEN 'paid' THEN 3
              WHEN 'free' THEN 2
              ELSE 1
            END DESC,
            r.confidence DESC,
            r.updated_at DESC
        ) AS rn
      FROM candidates c
      LEFT JOIN curb_rules r
        ON r.curb_segment_id = c.id
       AND (r.day_mask & $5) <> 0
       AND (
         (r.start_minute < r.end_minute AND $6 >= r.start_minute AND $6 < r.end_minute)
         OR (r.start_minute > r.end_minute AND ($6 >= r.start_minute OR $6 < r.end_minute))
         OR (r.start_minute = 0 AND r.end_minute = 1440)
         OR (r.start_minute = r.end_minute)
       )
    ),
    selected AS (
      SELECT
        c.id::text AS segment_id,
        c.blockface_key,
        c.on_street,
        c.from_street,
        c.to_street,
        c.side_of_street,
        c.paid_hours,
        c.meter_rate,
        COALESCE(ar.status, 'unknown') AS status,
        COALESCE(ar.confidence, 0.25)::float8 AS confidence,
        ar.reason,
        ST_AsGeoJSON(c.geom)::jsonb AS geometry
      FROM candidates c
      LEFT JOIN active_rules ar
        ON ar.curb_segment_id = c.id
       AND ar.rn = 1
    )
    SELECT
      segment_id,
      blockface_key,
      on_street,
      from_street,
      to_street,
      side_of_street,
      paid_hours,
      meter_rate,
      status,
      confidence,
      reason,
      geometry,
      COUNT(*) OVER ()::int AS total_count
    FROM selected
    ORDER BY
      on_street NULLS LAST,
      from_street NULLS LAST,
      to_street NULLS LAST,
      segment_id
    LIMIT $7
    `,
    [input.minLng, input.minLat, input.maxLng, input.maxLat, window.dayBit, window.minuteOfDay, config.viewportMaxSegments]
  );

  const summary: ViewportSummary = {
    noParking: 0,
    paid: 0,
    free: 0,
    unknown: 0
  };

  let totalMatched = 0;
  const features: ViewportFeature[] = [];

  for (const row of result.rows) {
    totalMatched = row.total_count ?? totalMatched;

    const status = normalizeStatus(row.status);
    const geometry = parseGeometry(row.geometry);
    if (!geometry) continue;

    if (status === "no_parking") summary.noParking += 1;
    if (status === "paid") summary.paid += 1;
    if (status === "free") summary.free += 1;
    if (status === "unknown") summary.unknown += 1;

    features.push({
      type: "Feature",
      id: row.segment_id,
      geometry,
      properties: {
        blockfaceKey: row.blockface_key,
        status,
        color: statusColor(status),
        confidence: parseConfidence(row.confidence),
        reason: row.reason,
        onStreet: row.on_street,
        fromStreet: row.from_street,
        toStreet: row.to_street,
        sideOfStreet: row.side_of_street,
        paidHours: row.paid_hours,
        meterRate: row.meter_rate
      }
    });
  }

  return {
    type: "FeatureCollection",
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    timezone: config.timezone,
    totalMatched,
    returned: features.length,
    clipped: totalMatched > features.length,
    summary,
    features
  };
}
