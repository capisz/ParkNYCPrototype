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

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  port: toInt(process.env.PORT, 8080),
  timezone: process.env.TIMEZONE ?? "America/New_York",
  viewportMaxSegments: toInt(process.env.VIEWPORT_MAX_SEGMENTS, 6000),
  nycBaseUrl: process.env.NYC_BASE_URL ?? "https://data.cityofnewyork.us/resource",
  nycAppToken: normalizeOptionalToken(process.env.NYC_APP_TOKEN),
  nycMeterDatasetId: process.env.NYC_METER_DATASET_ID ?? "e7yp-wx55",
  nycSignsDatasetId: process.env.NYC_SIGNS_DATASET_ID ?? "nfid-uabd",
  nycGeometryDatasetId: process.env.NYC_GEOMETRY_DATASET_ID ?? "6yyb-pb25",
  nycPageLimit: toInt(process.env.NYC_PAGE_LIMIT, 5000),
  nycGeometryPageLimit: toInt(process.env.NYC_GEOMETRY_PAGE_LIMIT, 50000),
  nycMaxPages: toInt(process.env.NYC_MAX_PAGES, 0)
};

export function requireDatabaseUrl(): string {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return config.databaseUrl;
}
