import { config } from "../config";
import { dbQuery } from "../db";
import { parkingCalendarStateAt } from "./parkingCalendarService";
import { evaluateMeterGeometryPilot } from "./meterGeometryPolicy";

export type ParkingStatus = "cannot_park" | "paid" | "free" | "unknown";
export type Coverage = "full" | "partial" | "none";

type ViewportInput = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  centerLat?: number;
  centerLng?: number;
  radiusMeters?: number;
  zoom?: number;
  detail?: "map" | "full";
  start: Date;
  end: Date;
};

type DbRule = {
  status: "free" | "paid" | "no_parking" | "unknown";
  confidence: number | string;
  reason: string | null;
  source: string;
  dayMask: number;
  startMinute: number;
  endMinute: number;
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
  segment_source: string;
  source_run_id: string | null;
  source_updated_at: Date | string | null;
  geometry_validated: boolean;
  interpretation_version: string;
  geometry: unknown;
  rules: DbRule[] | null;
};

type LineStringGeometry = {
  type: "LineString" | "MultiLineString";
  coordinates: unknown;
};

export type StatusChange = {
  at: string;
  status: ParkingStatus;
};

export type SourceEvidence = {
  source: string;
  reason: string;
  confidence: number;
};

export type ViewportFeature = {
  type: "Feature";
  id: string;
  geometry: LineStringGeometry;
  properties: {
    blockfaceKey: string;
    status: ParkingStatus;
    color: string;
    confidence: number;
    coverage: Coverage;
    geometryValidated: boolean;
    geometryBasis: "dot_approved_curb" | "official_meter_blockface" | "unvalidated";
    recommendationEligible: boolean;
    ruleSummary: string;
    evidence: SourceEvidence[];
    sourceVersion: string | null;
    sourceUpdatedAt: string | null;
    interpretationVersion: string;
    changes: StatusChange[];
    nextChange: string | null;
    verifyPostedSigns: true;
    onStreet: string | null;
    fromStreet: string | null;
    toStreet: string | null;
    sideOfStreet: string | null;
    paidHours: string | null;
    meterRate: string | null;
  };
};

export type ViewportMapFeature = {
  type: "Feature";
  id: string;
  geometry: LineStringGeometry;
  properties: Pick<ViewportFeature["properties"],
    "status" | "color" | "confidence" | "coverage" | "geometryValidated" |
    "geometryBasis" | "recommendationEligible" | "ruleSummary" | "nextChange" |
    "onStreet" | "fromStreet" | "toStreet" | "sideOfStreet">;
};

export type ViewportSummary = {
  cannotPark: number;
  paid: number;
  free: number;
  unknown: number;
};

export type ViewportResponse = {
  type: "FeatureCollection";
  generatedAt: string;
  interval: { start: string; end: string };
  timezone: string;
  totalMatched: number;
  returned: number;
  clipped: boolean;
  advisory: true;
  scope: {
    kind: "viewport" | "proximity";
    center: { latitude: number; longitude: number } | null;
    radiusMeters: number | null;
    zoom: number | null;
  };
  summary: ViewportSummary;
  features: Array<ViewportFeature | ViewportMapFeature>;
};

export type DatasetStatus = {
  dataset: string;
  datasetId: string;
  state: "fresh" | "stale" | "missing" | "failed";
  sourceUpdatedAt: string | null;
  sourceCheckedAt: string | null;
  publishedAt: string | null;
  rowCount: number | null;
  version: string | null;
  maxAgeHours: number;
};

export type AuthorityGate = {
  decisionKey: string;
  state: "pending" | "approved" | "rejected" | "superseded" | "missing";
  ownerAgency: string | null;
  summary: string | null;
  expiresAt: string | null;
  usable: boolean;
};

export type DataStatusResponse = {
  generatedAt: string;
  datasets: DatasetStatus[];
  authorityGates: AuthorityGate[];
};

const DAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
};

const DATASET_MAX_AGE_HOURS: Record<string, number> = {
  signs: 48,
  meters: 62 * 24,
  geometry: 62 * 24,
  facilities: 14 * 24
};

const DATA_STATUS_CACHE_MS = 15_000;
const VIEWPORT_CACHE_MS = 20_000;
const VIEWPORT_CACHE_ENTRIES = 24;
const localWindowFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: config.timezone,
  hour12: false,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit"
});
const timezoneOffsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: config.timezone,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
});
const localDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit"
});

let dataStatusCache: { expiresAt: number; value: Promise<DataStatusResponse> } | null = null;
const viewportCache = new Map<string, { expiresAt: number; value: Promise<FullViewportResponse> }>();

function viewportSegmentLimit(zoom: number | undefined): number {
  const level = zoom ?? 16;
  const zoomLimit = level < 16 ? 500 : level < 17 ? 800 : level < 18 ? 1_100 : 1_500;
  return Math.max(100, Math.min(config.viewportMaxSegments, zoomLimit));
}

function viewportGeometryTolerance(zoom: number | undefined): number {
  const level = zoom ?? 16;
  if (level < 16) return 0.00002;
  if (level < 17) return 0.00001;
  if (level < 18) return 0.000005;
  return 0.0000025;
}

function roundedCacheCoordinate(value: number): string {
  return value.toFixed(5);
}

function viewportCacheKey(input: ViewportInput): string {
  const spatial = input.centerLat != null && input.centerLng != null && input.radiusMeters != null
    ? ["radius", roundedCacheCoordinate(input.centerLat), roundedCacheCoordinate(input.centerLng), Math.round(input.radiusMeters)]
    : ["bbox", roundedCacheCoordinate(input.minLat), roundedCacheCoordinate(input.minLng),
      roundedCacheCoordinate(input.maxLat), roundedCacheCoordinate(input.maxLng)];
  return [...spatial, (input.zoom ?? 16).toFixed(1), input.start.toISOString(), input.end.toISOString()].join("|");
}

function pruneViewportCache(now: number): void {
  for (const [key, entry] of viewportCache) {
    if (entry.expiresAt <= now) viewportCache.delete(key);
  }
  while (viewportCache.size >= VIEWPORT_CACHE_ENTRIES) {
    const oldest = viewportCache.keys().next().value as string | undefined;
    if (!oldest) break;
    viewportCache.delete(oldest);
  }
}

function localWindow(at: Date): { dayBit: number; minuteOfDay: number } {
  const parts = localWindowFormatter.formatToParts(at);
  const weekday = parts.find(part => part.type === "weekday")?.value ?? "Sun";
  const rawHour = Number(parts.find(part => part.type === "hour")?.value ?? 0);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(parts.find(part => part.type === "minute")?.value ?? 0);
  return { dayBit: 1 << (DAY_INDEX[weekday] ?? 0), minuteOfDay: hour * 60 + minute };
}

function timezoneOffsetMs(date: Date): number {
  const parts = timezoneOffsetFormatter.formatToParts(date);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const hour = value("hour") === 24 ? 0 : value("hour");
  return Date.UTC(value("year"), value("month") - 1, value("day"), hour, value("minute"), value("second")) - date.getTime();
}

function zonedDate(reference: Date, dayOffset: number, minute: number): Date {
  const local = localDateFormatter.formatToParts(reference);
  const value = (type: string) => Number(local.find(part => part.type === type)?.value ?? 0);
  const normalizedMinute = minute === 1440 ? 0 : minute;
  const normalizedDayOffset = dayOffset + (minute === 1440 ? 1 : 0);
  const wallClock = Date.UTC(
    value("year"), value("month") - 1, value("day") + normalizedDayOffset,
    Math.floor(normalizedMinute / 60), normalizedMinute % 60
  );
  let candidate = new Date(wallClock);
  candidate = new Date(wallClock - timezoneOffsetMs(candidate));
  return candidate;
}

function ruleActive(rule: DbRule, at: Date): boolean {
  const window = localWindow(at);
  if (rule.startMinute < rule.endMinute) {
    return (rule.dayMask & window.dayBit) !== 0 &&
      window.minuteOfDay >= rule.startMinute && window.minuteOfDay < rule.endMinute;
  }
  if (rule.startMinute > rule.endMinute) {
    const yesterday = 1 << ((Math.log2(window.dayBit) + 6) % 7);
    return ((rule.dayMask & window.dayBit) !== 0 && window.minuteOfDay >= rule.startMinute) ||
      ((rule.dayMask & yesterday) !== 0 && window.minuteOfDay < rule.endMinute);
  }
  return rule.startMinute === 0 && rule.endMinute === 1440 && (rule.dayMask & window.dayBit) !== 0;
}

function normalizedRuleStatus(status: DbRule["status"]): ParkingStatus {
  return status === "no_parking" ? "cannot_park" : status;
}

function statusAt(rules: DbRule[], at: Date): { status: ParkingStatus; rules: DbRule[] } {
  const calendar = parkingCalendarStateAt(at);
  const active = rules.filter(rule => {
    if (!ruleActive(rule, at)) return false;
    if (calendar.alternateSideParking === "suspended" && rule.source.includes("alternate-side")) return false;
    if (calendar.meterRules === "suspended" && rule.status === "paid") return false;
    if (calendar.majorLegalHoliday && rule.status === "no_parking" && rule.dayMask !== 127) return false;
    return true;
  });
  if (active.some(rule => rule.status === "no_parking")) {
    return { status: "cannot_park", rules: active.filter(rule => rule.status === "no_parking") };
  }
  if (active.length === 0 || active.some(rule => rule.status === "unknown")) {
    return { status: "unknown", rules: active.filter(rule => rule.status === "unknown") };
  }
  if (active.some(rule => rule.status === "paid")) {
    return { status: "paid", rules: active.filter(rule => rule.status === "paid") };
  }
  if (active.some(rule => rule.status === "free")) {
    return { status: "free", rules: active.filter(rule => rule.status === "free") };
  }
  return { status: "unknown", rules: active };
}

function intervalCheckpoints(start: Date, end: Date, rules: DbRule[]): Date[] {
  const points = new Set<number>([start.getTime(), Math.max(start.getTime(), end.getTime() - 1)]);
  const durationDays = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  for (let dayOffset = -1; dayOffset <= durationDays + 1; dayOffset += 1) {
    for (const rule of rules) {
      for (const minute of [rule.startMinute, rule.endMinute]) {
        const boundary = zonedDate(start, dayOffset, minute).getTime();
        for (const candidate of [boundary - 1, boundary, boundary + 1]) {
          if (candidate >= start.getTime() && candidate < end.getTime()) points.add(candidate);
        }
      }
    }
    const midnight = zonedDate(start, dayOffset, 0).getTime();
    if (midnight >= start.getTime() && midnight < end.getTime()) points.add(midnight);
  }
  return [...points].sort((a, b) => a - b).map(value => new Date(value));
}

function parseConfidence(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.1;
}

function classifyInterval(rules: DbRule[], start: Date, end: Date): {
  status: ParkingStatus;
  coverage: Coverage;
  confidence: number;
  evidence: SourceEvidence[];
  changes: StatusChange[];
} {
  const checks = intervalCheckpoints(start, end, rules).map(at => ({ at, ...statusAt(rules, at) }));
  const statuses = checks.map(check => check.status);
  const status: ParkingStatus = statuses.includes("cannot_park") ? "cannot_park" :
    statuses.includes("unknown") ? "unknown" : statuses.includes("paid") ? "paid" :
      statuses.length > 0 && statuses.every(value => value === "free") ? "free" : "unknown";
  const relevantRules = checks.flatMap(check => check.rules);
  const evidenceMap = new Map<string, SourceEvidence>();
  for (const rule of relevantRules) {
    const evidence: SourceEvidence = {
      source: rule.source,
      reason: rule.reason ?? "Recognized parking rule.",
      confidence: parseConfidence(rule.confidence)
    };
    evidenceMap.set(`${evidence.source}|${evidence.reason}`, evidence);
  }
  for (const check of checks) {
    const calendar = parkingCalendarStateAt(check.at);
    if (calendar.alternateSideParking !== "suspended") continue;
    const reason = calendar.majorLegalHoliday
      ? `${calendar.reason}: NYC DOT scheduled alternate-side parking, meter rules, and eligible non-seven-day restrictions as suspended.`
      : calendar.reason === "Sunday"
        ? "Sunday: NYC DOT reports alternate-side parking and meter rules are not in effect."
        : `${calendar.reason}: NYC DOT scheduled alternate-side street-cleaning rules as suspended.`;
    evidenceMap.set(`nyc-dot-calendar|${calendar.date}`, {
      source: "nyc-dot-calendar",
      reason,
      confidence: 0.99
    });
  }
  const changes: StatusChange[] = [];
  for (const check of checks) {
    const previous = changes.at(-1);
    if (!previous || previous.status !== check.status) {
      changes.push({ at: check.at.toISOString(), status: check.status });
    }
  }
  const confidence = relevantRules.length > 0
    ? Math.min(...relevantRules.map(rule => parseConfidence(rule.confidence)))
    : 0.1;
  return {
    status,
    coverage: status === "unknown" ? (relevantRules.length > 0 ? "partial" : "none") : "full",
    confidence,
    evidence: [...evidenceMap.values()],
    changes
  };
}

function statusColor(status: ParkingStatus): string {
  if (status === "cannot_park") return "#D3232A";
  if (status === "paid") return "#F2C14E";
  if (status === "free") return "#238B45";
  return "#667085";
}

function parseGeometry(value: unknown): LineStringGeometry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { type?: unknown; coordinates?: unknown };
  if ((candidate.type === "LineString" || candidate.type === "MultiLineString") && candidate.coordinates !== undefined) {
    return { type: candidate.type, coordinates: candidate.coordinates };
  }
  return null;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function loadDataStatus(now: Date): Promise<DataStatusResponse> {
  const [result, decisions] = await Promise.all([dbQuery<{
    dataset_key: string;
    source_dataset_id: string;
    status: string;
    source_updated_at: Date | string | null;
    source_checked_at: Date | string | null;
    published_at: Date | string | null;
    row_count: number | null;
    id: string;
  }>(`
    SELECT DISTINCT ON (dataset_key)
      dataset_key, source_dataset_id, status, source_updated_at, source_checked_at,
      published_at, row_count, id::text
    FROM ingestion_runs
    ORDER BY dataset_key, started_at DESC
  `), dbQuery<{
    decision_key: string;
    status: "pending" | "approved" | "rejected" | "superseded";
    owner_agency: string;
    summary: string;
    expires_at: Date | string | null;
  }>(`
    SELECT decision_key, status, owner_agency, summary, expires_at
    FROM data_stewardship_decisions
    WHERE decision_key = ANY($1::text[])
  `, [["curb-geometry-authority", "parking-rule-catalog-v2", "facility-directory-use"]])]);
  const byDataset = new Map(result.rows.map(row => [row.dataset_key, row]));
  const configured = [
    ["geometry", config.nycGeometryDatasetId],
    ["meters", config.nycMeterDatasetId],
    ["signs", config.nycSignsDatasetId],
    ["facilities", config.nycGarageDatasetId]
  ] as const;
  const datasets = configured.map(([dataset, datasetId]): DatasetStatus => {
    const row = byDataset.get(dataset);
    const maxAgeHours = DATASET_MAX_AGE_HOURS[dataset];
    const sourceUpdatedAt = iso(row?.source_updated_at ?? null);
    const sourceCheckedAt = iso(row?.source_checked_at ?? null);
    const ageHours = sourceCheckedAt == null ? Number.POSITIVE_INFINITY :
      (now.getTime() - new Date(sourceCheckedAt).getTime()) / 3_600_000;
    const state = !row ? "missing" : row.status === "failed" ? "failed" :
      row.status !== "published" || sourceUpdatedAt == null || ageHours > maxAgeHours ? "stale" : "fresh";
    return {
      dataset, datasetId, state, sourceUpdatedAt, sourceCheckedAt,
      publishedAt: iso(row?.published_at ?? null),
      rowCount: row?.row_count ?? null,
      version: row?.id ?? null,
      maxAgeHours
    };
  });
  const byDecision = new Map(decisions.rows.map(row => [row.decision_key, row]));
  const authorityGates = [
    "curb-geometry-authority", "parking-rule-catalog-v2", "facility-directory-use"
  ].map((decisionKey): AuthorityGate => {
    const row = byDecision.get(decisionKey);
    const expiresAt = iso(row?.expires_at ?? null);
    const usable = row?.status === "approved" && (expiresAt == null || new Date(expiresAt) > now);
    return {
      decisionKey,
      state: row?.status ?? "missing",
      ownerAgency: row?.owner_agency ?? null,
      summary: row?.summary ?? null,
      expiresAt,
      usable
    };
  });
  return { generatedAt: now.toISOString(), datasets, authorityGates };
}

export async function getDataStatus(now?: Date): Promise<DataStatusResponse> {
  if (now) return loadDataStatus(now);
  const current = Date.now();
  if (dataStatusCache && dataStatusCache.expiresAt > current) return dataStatusCache.value;
  const value = loadDataStatus(new Date(current));
  dataStatusCache = { expiresAt: current + DATA_STATUS_CACHE_MS, value };
  value.catch(() => {
    if (dataStatusCache?.value === value) dataStatusCache = null;
  });
  return value;
}

function relevantDatasets(rules: DbRule[]): Set<string> {
  const result = new Set<string>(["geometry"]);
  for (const rule of rules) {
    if (rule.source.includes("sign")) result.add("signs");
    if (rule.source.includes("meter")) result.add("meters");
  }
  return result;
}

type Classification = ReturnType<typeof classifyInterval>;
type ClassificationContext = {
  dataStatus: DataStatusResponse;
  statusByDataset: Map<string, DatasetStatus>;
  curbAuthorityReady: boolean;
};

function safetyClassification(reason: string, start: Date): Classification {
  return {
    status: "unknown",
    coverage: "none",
    confidence: 0.1,
    evidence: [{ source: "safety-gate", reason, confidence: 0.1 }],
    changes: [{ at: start.toISOString(), status: "unknown" }]
  };
}

function classifyViewportRow(
  row: DbViewportRow,
  input: Pick<ViewportInput, "start" | "end">,
  context: ClassificationContext
): {
  classification: Classification;
  requiredDatasets: Set<string>;
  geometryBasis: ViewportFeature["properties"]["geometryBasis"];
  recommendationEligible: boolean;
} {
  const rules = Array.isArray(row.rules) ? row.rules : [];
  const meterDataset = context.statusByDataset.get("meters");
  const signsDataset = context.statusByDataset.get("signs");
  const meterReferenceCandidate = row.segment_source === `meters:${config.nycMeterDatasetId}` &&
    meterDataset?.state === "fresh" && row.source_run_id != null && row.source_run_id === meterDataset.version;
  const canEvaluateRules = (context.curbAuthorityReady && row.geometry_validated) || meterReferenceCandidate;
  let classification = canEvaluateRules
    ? classifyInterval(rules, input.start, input.end)
    : safetyClassification(
      !context.curbAuthorityReady
        ? "NYC DOT geometry and rule-catalog approvals have not passed."
        : "Curb-side geometry has not been approved by NYC DOT.",
      input.start
    );

  const meterDecision = meterReferenceCandidate ? evaluateMeterGeometryPilot({
    segmentSource: row.segment_source,
    configuredDatasetId: config.nycMeterDatasetId,
    sideOfStreet: row.side_of_street,
    paidHours: row.paid_hours,
    meterRate: row.meter_rate,
    sourceRunId: row.source_run_id,
    activeDatasetVersion: meterDataset?.version ?? null,
    datasetState: meterDataset?.state ?? "missing",
    signsDatasetState: signsDataset?.state ?? "missing",
    classification
  }) : null;

  if (meterDecision?.usableForReferenceDisplay) {
    if (meterDecision.evidence) {
      classification = {
        ...classification,
        status: meterDecision.displayStatus ?? classification.status,
        evidence: [...classification.evidence, meterDecision.evidence]
      };
    }
    return {
      classification,
      requiredDatasets: new Set(
        meterDecision.usableForProhibitedDisplay || meterDecision.usableForFreeDisplay
          ? ["meters", "signs"]
          : ["meters"]
      ),
      geometryBasis: meterDecision.geometryBasis,
      recommendationEligible: false
    };
  }

  const requiredDatasets = relevantDatasets(rules);
  const sourcesFresh = [...requiredDatasets].every(dataset => context.statusByDataset.get(dataset)?.state === "fresh");
  if (!row.geometry_validated || !sourcesFresh || !context.curbAuthorityReady) {
    const missing = !context.curbAuthorityReady
      ? "NYC DOT geometry and rule-catalog approvals have not passed."
      : !row.geometry_validated
        ? "Curb-side geometry has not been approved by NYC DOT."
        : "One or more required source datasets are stale or unavailable.";
    classification = safetyClassification(missing, input.start);
  }

  return {
    classification,
    requiredDatasets,
    geometryBasis: row.geometry_validated && context.curbAuthorityReady ? "dot_approved_curb" : "unvalidated",
    recommendationEligible: row.geometry_validated && sourcesFresh && context.curbAuthorityReady &&
      classification.coverage === "full" && (classification.status === "free" || classification.status === "paid")
  };
}

function featureFromRow(
  row: DbViewportRow,
  input: Pick<ViewportInput, "start" | "end">,
  context: ClassificationContext
): ViewportFeature | null {
  const geometry = parseGeometry(row.geometry);
  if (!geometry) return null;
  const { classification, requiredDatasets, geometryBasis, recommendationEligible } =
    classifyViewportRow(row, input, context);
  const sourceDates = [...requiredDatasets]
    .map(dataset => context.statusByDataset.get(dataset)?.sourceUpdatedAt)
    .filter((value): value is string => value != null)
    .sort();
  const nextChange = classification.changes.find(change => Date.parse(change.at) > input.start.getTime())?.at ?? null;
  const ruleSummary = classification.status === "cannot_park"
    ? "Red means cannot park during at least part of this planned interval."
    : classification.status === "paid"
      ? "Yellow means paid parking during at least part of this planned interval."
      : classification.status === "free"
        ? "Green means likely free curb parking for the complete planned interval; verify posted signs."
        : classification.evidence[0]?.reason ?? "Parking status is unknown; check posted signs.";

  return {
    type: "Feature",
    id: row.segment_id,
    geometry,
    properties: {
      blockfaceKey: row.blockface_key,
      status: classification.status,
      color: statusColor(classification.status),
      confidence: classification.confidence,
      coverage: classification.coverage,
      geometryValidated: row.geometry_validated,
      geometryBasis,
      recommendationEligible,
      ruleSummary,
      evidence: classification.evidence,
      sourceVersion: row.source_run_id,
      sourceUpdatedAt: sourceDates[0] ?? iso(row.source_updated_at),
      interpretationVersion: row.interpretation_version,
      changes: classification.changes,
      nextChange,
      verifyPostedSigns: true,
      onStreet: row.on_street,
      fromStreet: row.from_street,
      toStreet: row.to_street,
      sideOfStreet: row.side_of_street,
      paidHours: row.paid_hours,
      meterRate: row.meter_rate
    }
  };
}

function compactMapFeature(feature: ViewportFeature): ViewportMapFeature {
  const properties = feature.properties;
  return {
    type: "Feature",
    id: feature.id,
    geometry: feature.geometry,
    properties: {
      status: properties.status,
      color: properties.color,
      confidence: properties.confidence,
      coverage: properties.coverage,
      geometryValidated: properties.geometryValidated,
      geometryBasis: properties.geometryBasis,
      recommendationEligible: properties.recommendationEligible,
      ruleSummary: properties.ruleSummary,
      nextChange: properties.nextChange,
      onStreet: properties.onStreet,
      fromStreet: properties.fromStreet,
      toStreet: properties.toStreet,
      sideOfStreet: properties.sideOfStreet
    }
  };
}

type FullViewportResponse = Omit<ViewportResponse, "features"> & { features: ViewportFeature[] };
type MapViewportResponse = Omit<ViewportResponse, "features"> & { features: ViewportMapFeature[] };

async function loadViewportParking(input: ViewportInput): Promise<FullViewportResponse> {
  const startedAt = performance.now();
  const dataStatus = await getDataStatus();
  const statusLoadedAt = performance.now();
  const statusByDataset = new Map(dataStatus.datasets.map(dataset => [dataset.dataset, dataset]));
  const curbAuthorityReady = ["curb-geometry-authority", "parking-rule-catalog-v2"].every(decisionKey =>
    dataStatus.authorityGates.find(gate => gate.decisionKey === decisionKey)?.usable === true
  );
  const meterDataset = statusByDataset.get("meters");
  const includeApprovedRules = curbAuthorityReady;
  const includeMeterReferenceRules = meterDataset?.state === "fresh" && meterDataset.version != null;
  const segmentLimit = viewportSegmentLimit(input.zoom);
  const geometryTolerance = viewportGeometryTolerance(input.zoom);
  const spatialParams = [
    input.minLng, input.minLat, input.maxLng, input.maxLat,
    input.centerLng ?? null, input.centerLat ?? null, input.radiusMeters ?? null
  ];
  const scopeSql = `
    WITH bbox AS (
      SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS geom
    ), scope AS (
      SELECT
        CASE WHEN $5::float8 IS NULL THEN b.geom ELSE ST_Intersection(
          b.geom,
          ST_Buffer(ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7)::geometry
        ) END AS geom,
        CASE WHEN $5::float8 IS NULL THEN ST_Centroid(b.geom)
          ELSE ST_SetSRID(ST_MakePoint($5, $6), 4326) END AS sort_point
      FROM bbox b
    )`;
  const featureQuery = dbQuery<DbViewportRow>(`${scopeSql}, candidates AS (
      SELECT
        s.id, s.blockface_key, s.on_street, s.from_street, s.to_street,
        s.side_of_street, s.paid_hours, s.meter_rate, s.source,
        s.source_run_id, s.source_updated_at, s.geometry_validated,
        s.interpretation_version, s.geom,
        ST_CollectionExtract(ST_Intersection(s.geom, q.geom), 2) AS clipped_geom
      FROM curb_segments s
      CROSS JOIN scope q
      WHERE s.geom && q.geom AND ST_Intersects(s.geom, q.geom)
        AND (s.geometry_validated OR s.source LIKE 'meters:%')
        AND (
          ($10::boolean AND s.geometry_validated) OR
          ($11::boolean AND s.source = $12 AND s.source_run_id::text = $13)
        )
      ORDER BY s.geom <-> q.sort_point, s.id
      LIMIT $8
    )
    SELECT
      c.id::text AS segment_id,
      c.blockface_key,
      c.on_street,
      c.from_street,
      c.to_street,
      c.side_of_street,
      c.paid_hours,
      c.meter_rate,
      c.source AS segment_source,
      c.source_run_id::text,
      c.source_updated_at,
      c.geometry_validated,
      c.interpretation_version,
      ST_AsGeoJSON(
        ST_SimplifyPreserveTopology(c.clipped_geom, $9), 6, 0
      )::jsonb AS geometry,
      COALESCE(rule_data.rules, '[]'::jsonb) AS rules
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'status', r.status,
        'confidence', r.confidence,
        'reason', r.reason,
        'source', r.source,
        'dayMask', r.day_mask,
        'startMinute', r.start_minute,
        'endMinute', r.end_minute
      ) ORDER BY r.updated_at DESC) AS rules
      FROM curb_rules r
      WHERE r.curb_segment_id = c.id AND (
        ($10::boolean AND c.geometry_validated) OR
        ($11::boolean AND c.source = $12 AND c.source_run_id::text = $13)
      )
    ) rule_data ON true
    WHERE NOT ST_IsEmpty(c.clipped_geom)
    ORDER BY c.geom <-> (SELECT sort_point FROM scope), c.id
  `, [
    ...spatialParams, segmentLimit, geometryTolerance,
    includeApprovedRules, includeMeterReferenceRules,
    `meters:${config.nycMeterDatasetId}`, meterDataset?.version ?? null
  ]);
  const countQuery = dbQuery<{ total_count: number | string }>(`${scopeSql}
    SELECT COUNT(*) AS total_count
    FROM curb_segments s
    CROSS JOIN scope q
    WHERE s.geom && q.geom AND ST_Intersects(s.geom, q.geom)
      AND (s.geometry_validated OR s.source LIKE 'meters:%')
      AND (
        ($8::boolean AND s.geometry_validated) OR
        ($9::boolean AND s.source = $10 AND s.source_run_id::text = $11)
      )
  `, [
    ...spatialParams, includeApprovedRules, includeMeterReferenceRules,
    `meters:${config.nycMeterDatasetId}`, meterDataset?.version ?? null
  ]);
  const [result, countResult] = await Promise.all([featureQuery, countQuery]);
  const queriedAt = performance.now();

  const summary: ViewportSummary = { cannotPark: 0, paid: 0, free: 0, unknown: 0 };
  const features: ViewportFeature[] = [];
  const totalMatched = Number(countResult.rows[0]?.total_count ?? result.rows.length);
  const context: ClassificationContext = { dataStatus, statusByDataset, curbAuthorityReady };

  for (const row of result.rows) {
    const feature = featureFromRow(row, input, context);
    if (!feature) continue;
    summary[feature.properties.status === "cannot_park" ? "cannotPark" : feature.properties.status] += 1;
    features.push(feature);
  }

  const finishedAt = performance.now();
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    event: "curb_viewport_generated",
    dataStatusMs: Math.round((statusLoadedAt - startedAt) * 10) / 10,
    queryMs: Math.round((queriedAt - statusLoadedAt) * 10) / 10,
    classifyMs: Math.round((finishedAt - queriedAt) * 10) / 10,
    durationMs: Math.round((finishedAt - startedAt) * 10) / 10,
    totalMatched,
    returned: features.length,
    segmentLimit,
    rulesLoaded: result.rows.reduce((count, row) => count + (Array.isArray(row.rules) ? row.rules.length : 0), 0)
  }));

  return {
    type: "FeatureCollection",
    generatedAt: new Date().toISOString(),
    interval: { start: input.start.toISOString(), end: input.end.toISOString() },
    timezone: config.timezone,
    totalMatched,
    returned: features.length,
    clipped: totalMatched > features.length,
    advisory: true,
    scope: {
      kind: input.radiusMeters == null ? "viewport" : "proximity",
      center: input.centerLat == null || input.centerLng == null ? null : {
        latitude: input.centerLat, longitude: input.centerLng
      },
      radiusMeters: input.radiusMeters ?? null,
      zoom: input.zoom ?? null
    },
    summary,
    features
  };
}

export function getViewportParking(input: ViewportInput & { detail: "map" }): Promise<MapViewportResponse>;
export function getViewportParking(input: ViewportInput & { detail?: "full" }): Promise<FullViewportResponse>;
export function getViewportParking(input: ViewportInput): Promise<ViewportResponse>;
export async function getViewportParking(input: ViewportInput): Promise<ViewportResponse> {
  const key = viewportCacheKey(input);
  const now = Date.now();
  pruneViewportCache(now);
  let entry = viewportCache.get(key);
  if (entry && entry.expiresAt > now) {
    viewportCache.delete(key);
    viewportCache.set(key, entry);
  } else {
    const value = loadViewportParking({ ...input, detail: "full" });
    entry = { expiresAt: now + VIEWPORT_CACHE_MS, value };
    viewportCache.set(key, entry);
    value.catch(() => {
      if (viewportCache.get(key)?.value === value) viewportCache.delete(key);
    });
  }
  const response = await entry.value;
  if (input.detail !== "map") return response;
  return { ...response, features: response.features.map(compactMapFeature) };
}

export async function getCurbParkingDetail(
  segmentId: string,
  start: Date,
  end: Date
): Promise<ViewportFeature | null> {
  const startedAt = performance.now();
  const dataStatus = await getDataStatus();
  const statusByDataset = new Map(dataStatus.datasets.map(dataset => [dataset.dataset, dataset]));
  const curbAuthorityReady = ["curb-geometry-authority", "parking-rule-catalog-v2"].every(decisionKey =>
    dataStatus.authorityGates.find(gate => gate.decisionKey === decisionKey)?.usable === true
  );
  const meterDataset = statusByDataset.get("meters");
  const result = await dbQuery<DbViewportRow>(`
    SELECT
      s.id::text AS segment_id,
      s.blockface_key,
      s.on_street,
      s.from_street,
      s.to_street,
      s.side_of_street,
      s.paid_hours,
      s.meter_rate,
      s.source AS segment_source,
      s.source_run_id::text,
      s.source_updated_at,
      s.geometry_validated,
      s.interpretation_version,
      ST_AsGeoJSON(s.geom, 6, 0)::jsonb AS geometry,
      COALESCE(rule_data.rules, '[]'::jsonb) AS rules
    FROM curb_segments s
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'status', r.status,
        'confidence', r.confidence,
        'reason', r.reason,
        'source', r.source,
        'dayMask', r.day_mask,
        'startMinute', r.start_minute,
        'endMinute', r.end_minute
      ) ORDER BY r.updated_at DESC) AS rules
      FROM curb_rules r
      WHERE r.curb_segment_id = s.id AND (
        ($2::boolean AND s.geometry_validated) OR
        ($3::boolean AND s.source = $4 AND s.source_run_id::text = $5)
      )
    ) rule_data ON true
    WHERE s.id = $1::uuid
  `, [
    segmentId,
    curbAuthorityReady,
    meterDataset?.state === "fresh" && meterDataset.version != null,
    `meters:${config.nycMeterDatasetId}`,
    meterDataset?.version ?? null
  ]);
  const row = result.rows[0];
  const feature = row ? featureFromRow(row, { start, end }, { dataStatus, statusByDataset, curbAuthorityReady }) : null;
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(), level: "info", event: "curb_detail_generated",
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10, found: feature != null
  }));
  return feature;
}

export const parkingServiceInternals = {
  classifyInterval,
  intervalCheckpoints,
  normalizedRuleStatus,
  statusColor,
  viewportSegmentLimit,
  viewportGeometryTolerance,
  viewportCacheKey,
  compactMapFeature
};
