import dotenv from "dotenv";

dotenv.config();

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeOptionalToken(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  const upper = trimmed.toUpperCase();
  if (upper.includes("REPLACE_WITH") || upper.includes("CHANGE_ME") || upper.includes("APP_TOKEN")) {
    return "";
  }
  return trimmed;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  port: toInt(process.env.PORT, 8080),
  timezone: process.env.TIMEZONE ?? "America/New_York",
  viewportMaxSegments: toInt(process.env.VIEWPORT_MAX_SEGMENTS, 1500),
  nycBaseUrl: process.env.NYC_BASE_URL ?? "https://data.cityofnewyork.us/resource",
  nycAppToken: normalizeOptionalToken(process.env.NYC_APP_TOKEN),
  nycMeterDatasetId: process.env.NYC_METER_DATASET_ID ?? "e7yp-wx55",
  nycSignsDatasetId: process.env.NYC_SIGNS_DATASET_ID ?? "nfid-uabd",
  nycGeometryDatasetId: process.env.NYC_GEOMETRY_DATASET_ID ?? "6yyb-pb25",
  nycHydrantDatasetId: process.env.NYC_HYDRANT_DATASET_ID ?? "5bgh-vtsn",
  nycGarageDatasetId: process.env.NYC_GARAGE_DATASET_ID ?? "w7w3-xahh",
  mtaBaseUrl: process.env.MTA_BASE_URL ?? "https://data.ny.gov/resource",
  mtaSubwayEntrancesDatasetId: process.env.MTA_SUBWAY_ENTRANCES_DATASET_ID ?? "i9wp-a4ja",
  geoSearchBaseUrl: process.env.GEOSEARCH_BASE_URL ?? "https://geosearch.planninglabs.nyc/v2",
  nycPageLimit: toInt(process.env.NYC_PAGE_LIMIT, 5000),
  nycGeometryPageLimit: toInt(process.env.NYC_GEOMETRY_PAGE_LIMIT, 50000),
  nycMaxPages: toInt(process.env.NYC_MAX_PAGES, 0),
  allowPartialIngest: toBoolean(process.env.ALLOW_PARTIAL_INGEST, false),
  trustMeterGeometry: toBoolean(process.env.TRUST_METER_GEOMETRY, false),
  enableSignRefresh: toBoolean(
    process.env.ENABLE_SIGN_REFRESH,
    process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test"
  ),
  signRefreshMinutes: Math.max(15, toInt(process.env.SIGN_REFRESH_MINUTES, 360)),
  features: {
    curbGuidance: toBoolean(process.env.ENABLE_CURB_GUIDANCE, process.env.NODE_ENV !== "production"),
    garages: toBoolean(process.env.ENABLE_GARAGES, process.env.NODE_ENV !== "production"),
    transit: toBoolean(process.env.ENABLE_TRANSIT, false)
  },
  operationsToken: normalizeOptionalToken(process.env.OPERATIONS_TOKEN),
  otpBaseUrl: (process.env.OTP_BASE_URL ?? "").trim(),
  mtaApiKey: normalizeOptionalToken(process.env.MTA_API_KEY)
};

export function requireDatabaseUrl(): string {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return config.databaseUrl;
}
