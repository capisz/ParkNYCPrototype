import { config } from "../config";
import { dbQuery } from "../db";

type ParkingStatus = "free" | "paid" | "no_parking" | "unknown";

type LocalTimeWindow = {
  weekday: string;
  dayIndex: number;
  minuteOfDay: number;
  dayBit: number;
  previousDayBit: number;
};

type ViewportInput = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  centerLat?: number;
  centerLng?: number;
  radiusMeters?: number;
  zoom?: number;
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
  rule_source: string | null;
  day_mask: number | null;
  start_minute: number | null;
  end_minute: number | null;
  source_freshness: Date | string | null;
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
    ruleSummary: string;
    source: string | null;
    nextChange: string | null;
    sourceFreshness: string | null;
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
  scope: {
    kind: "viewport" | "proximity";
    center: { latitude: number; longitude: number } | null;
    radiusMeters: number | null;
    zoom: number | null;
  };
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

  const previousDayBit = 1 << ((dayIdx + 6) % 7);
  return { weekday, dayIndex: dayIdx, minuteOfDay, dayBit, previousDayBit };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const hour = value("hour") === 24 ? 0 : value("hour");
  return Date.UTC(value("year"), value("month") - 1, value("day"), hour, value("minute"), value("second")) - date.getTime();
}

function zonedDate(reference: Date, timezone: string, dayOffset: number, minute: number): Date {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(reference);
  const value = (type: string) => Number(local.find(part => part.type === type)?.value ?? 0);
  const wallClock = Date.UTC(value("year"), value("month") - 1, value("day") + dayOffset, Math.floor(minute / 60), minute % 60);
  let candidate = new Date(wallClock);
  candidate = new Date(wallClock - timezoneOffsetMs(candidate, timezone));
  return candidate;
}

function nextRuleBoundary(row: DbViewportRow, asOf: Date, window: LocalTimeWindow): string | null {
  if (row.end_minute == null || row.day_mask == null || row.status == null) return null;
  const overnight = (row.start_minute ?? 0) > row.end_minute;
  const dayOffset = overnight && window.minuteOfDay >= (row.start_minute ?? 0) ? 1 : 0;
  const boundary = zonedDate(
    asOf,
    config.timezone,
    dayOffset + (row.end_minute === 1440 ? 1 : 0),
    row.end_minute === 1440 ? 0 : row.end_minute
  );
  return boundary > asOf ? boundary.toISOString() : null;
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
    scope AS (
      SELECT CASE
        WHEN $8::float8 IS NULL THEN b.geom
        ELSE ST_Intersection(
          b.geom,
          ST_Buffer(
            ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography,
            $10
          )::geometry
        )
      END AS geom
      FROM bbox b
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
        s.updated_at,
        clipped.geom
      FROM curb_segments s
      JOIN scope query_scope ON ST_Intersects(s.geom, query_scope.geom)
      CROSS JOIN LATERAL (
        SELECT ST_CollectionExtract(ST_Intersection(s.geom, query_scope.geom), 2) AS geom
      ) clipped
      WHERE NOT ST_IsEmpty(clipped.geom)
    ),
    active_rules AS (
      SELECT
        c.id AS curb_segment_id,
        r.status,
        r.confidence,
        r.reason,
        r.source,
        r.day_mask,
        r.start_minute,
        r.end_minute,
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
       AND (
         (r.start_minute < r.end_minute AND (r.day_mask & $5) <> 0 AND $7 >= r.start_minute AND $7 < r.end_minute)
         OR (r.start_minute > r.end_minute AND (
           ((r.day_mask & $5) <> 0 AND $7 >= r.start_minute)
           OR ((r.day_mask & $6) <> 0 AND $7 < r.end_minute)
         ))
         OR (r.start_minute = 0 AND r.end_minute = 1440 AND (r.day_mask & $5) <> 0)
       )
    ),
    rule_evidence AS (
      SELECT
        c.id AS curb_segment_id,
        BOOL_OR(
          r.status <> 'unknown' AND r.confidence >= 0.78
          AND NOT (r.start_minute = 0 AND r.end_minute = 1440)
        ) AS has_reliable_schedule
      FROM candidates c
      LEFT JOIN curb_rules r ON r.curb_segment_id = c.id
      GROUP BY c.id
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
        CASE WHEN ar.status IS NULL AND re.has_reliable_schedule THEN 'free'
          ELSE COALESCE(ar.status, 'unknown') END AS status,
        CASE WHEN ar.status IS NULL AND re.has_reliable_schedule THEN 0.68
          ELSE COALESCE(ar.confidence, 0.25) END::float8 AS confidence,
        CASE WHEN ar.status IS NULL AND re.has_reliable_schedule
          THEN 'No known sign or meter restriction is active in this curb schedule. Verify posted signs and general NYC parking rules.'
          ELSE ar.reason END AS reason,
        CASE WHEN ar.status IS NULL AND re.has_reliable_schedule
          THEN 'derived-schedule-gap' ELSE ar.source END AS rule_source,
        ar.day_mask,
        ar.start_minute,
        ar.end_minute,
        c.updated_at AS source_freshness,
        ST_AsGeoJSON(c.geom)::jsonb AS geometry
      FROM candidates c
      LEFT JOIN active_rules ar
        ON ar.curb_segment_id = c.id
       AND ar.rn = 1
      LEFT JOIN rule_evidence re ON re.curb_segment_id = c.id
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
      rule_source,
      day_mask,
      start_minute,
      end_minute,
      source_freshness,
      geometry,
      COUNT(*) OVER ()::int AS total_count
    FROM selected
    ORDER BY
      on_street NULLS LAST,
      from_street NULLS LAST,
      to_street NULLS LAST,
      segment_id
    LIMIT $11
    `,
    [
      input.minLng, input.minLat, input.maxLng, input.maxLat,
      window.dayBit, window.previousDayBit, window.minuteOfDay,
      input.centerLng ?? null, input.centerLat ?? null, input.radiusMeters ?? null,
      config.viewportMaxSegments
    ]
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
        ruleSummary: row.reason ?? "Parking status is unknown because no active, reliable rule matched this curb.",
        source: row.rule_source,
        nextChange: nextRuleBoundary(row, asOf, window),
        sourceFreshness: row.source_freshness ? new Date(row.source_freshness).toISOString() : null,
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
    scope: {
      kind: input.radiusMeters == null ? "viewport" : "proximity",
      center: input.centerLat == null || input.centerLng == null ? null : {
        latitude: input.centerLat,
        longitude: input.centerLng
      },
      radiusMeters: input.radiusMeters ?? null,
      zoom: input.zoom ?? null
    },
    summary,
    features
  };
}
