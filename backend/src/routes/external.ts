import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { fetchGaragesNear } from "../services/externalDataService";
import { getDataStatus } from "../services/parkingService";

const router = Router();
const textQuery = z.object({ text: z.string().trim().min(2).max(160) });
const autocompleteQuery = z.object({ q: z.string().trim().min(2).max(160) });
const viewportQuery = z.object({
  minLat: z.coerce.number().min(40).max(41.5),
  minLng: z.coerce.number().min(-75).max(-73),
  maxLat: z.coerce.number().min(40).max(41.5),
  maxLng: z.coerce.number().min(-75).max(-73)
}).refine(v => v.minLat < v.maxLat && v.minLng < v.maxLng);
const nearQuery = z.object({
  lat: z.coerce.number().min(40).max(41.5),
  lng: z.coerce.number().min(-75).max(-73),
  radius: z.coerce.number().min(100).max(5000).default(1200)
});

const HYDRANT_RESTRICTION_RADIUS_METERS = 15 * 0.3048;
const HYDRANT_BUFFER_STEPS = 32;
const EARTH_RADIUS_METERS = 6_371_008.8;

type GeoJsonFeature = {
  type?: unknown;
  id?: unknown;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
  [key: string]: unknown;
};

function pointCoordinates(feature: GeoJsonFeature): [number, number] | null {
  if (feature.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return null;
  const longitude = feature.geometry.coordinates[0];
  const latitude = feature.geometry.coordinates[1];
  if (typeof longitude !== "number" || typeof latitude !== "number") return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  return [longitude, latitude];
}

function destinationPoint(
  [longitude, latitude]: [number, number],
  bearingRadians: number,
  distanceMeters: number
): [number, number] {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const toDegrees = (radians: number) => radians * 180 / Math.PI;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const latitudeRadians = toRadians(latitude);
  const longitudeRadians = toRadians(longitude);
  const targetLatitude = Math.asin(
    Math.sin(latitudeRadians) * Math.cos(angularDistance) +
    Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearingRadians)
  );
  const targetLongitude = longitudeRadians + Math.atan2(
    Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
    Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(targetLatitude)
  );
  const normalizedLongitude = ((toDegrees(targetLongitude) + 540) % 360) - 180;
  return [normalizedLongitude, toDegrees(targetLatitude)];
}

function restrictionRing(center: [number, number]): Array<[number, number]> {
  const ring = Array.from({ length: HYDRANT_BUFFER_STEPS }, (_, index) =>
    destinationPoint(center, index * 2 * Math.PI / HYDRANT_BUFFER_STEPS, HYDRANT_RESTRICTION_RADIUS_METERS)
  );
  ring.push(ring[0]);
  return ring;
}

function hydrantFeatures(feature: GeoJsonFeature, index: number): GeoJsonFeature[] {
  const center = pointCoordinates(feature);
  if (!center) return [];
  const properties = feature.properties ?? {};
  const sourceId = feature.id ?? properties.objectid ?? properties.hydrant_id ?? index;
  const point: GeoJsonFeature = {
    ...feature,
    type: "Feature",
    properties: {
      ...properties,
      kind: "hydrant",
      restrictionRadiusMeters: HYDRANT_RESTRICTION_RADIUS_METERS
    }
  };
  const restriction: GeoJsonFeature = {
    type: "Feature",
    id: `hydrant-restriction:${String(sourceId)}`,
    geometry: { type: "Polygon", coordinates: [restrictionRing(center)] },
    properties: {
      kind: "hydrant_exclusion",
      legacyKind: "hydrant_restriction",
      parkingStatus: "cannot_park",
      color: "#D3232A",
      restrictionRadiusMeters: HYDRANT_RESTRICTION_RADIUS_METERS,
      geometryAccuracy: "approximate_radial_buffer",
      curbLinked: false,
      advisory: true,
      sourceHydrantId: String(sourceId)
    }
  };
  return [restriction, point];
}

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1_000;
const SEARCH_CACHE_MAX_ENTRIES = 200;
const SEARCH_REQUEST_TIMEOUT_MS = 8_000;
const searchCache = new Map<string, { expiresAt: number; payload: unknown }>();
const searchInFlight = new Map<string, Promise<unknown>>();

type CuratedPlace = {
  aliases: string[];
  label: string;
  coordinates: [number, number];
  precision: "landmark" | "neighborhood_center";
};

// A deliberately small, reviewable degraded-mode directory keeps the planner
// usable when the live NYC geocoder is unavailable. Neighborhood entries are
// explicitly labeled as centers; they are not substitutes for street-address
// geocoding and never leave City infrastructure through the client.
const CURATED_PLACES: CuratedPlace[] = [
  { aliases: ["empire state building"], label: "Empire State Building, Manhattan, NY", coordinates: [-73.9857, 40.7484], precision: "landmark" },
  { aliases: ["times square", "6 times square"], label: "Times Square, Manhattan, NY", coordinates: [-73.9855, 40.7580], precision: "landmark" },
  { aliases: ["downtown brooklyn"], label: "Downtown Brooklyn neighborhood center, Brooklyn, NY", coordinates: [-73.9900, 40.6920], precision: "neighborhood_center" },
  { aliases: ["astoria"], label: "Astoria neighborhood center, Queens, NY", coordinates: [-73.9230, 40.7640], precision: "neighborhood_center" },
  { aliases: ["fordham"], label: "Fordham neighborhood center, Bronx, NY", coordinates: [-73.8900, 40.8610], precision: "neighborhood_center" },
  { aliases: ["st george", "saint george"], label: "St. George neighborhood center, Staten Island, NY", coordinates: [-74.0730, 40.6430], precision: "neighborhood_center" }
];

function curatedSearchPayload(path: "search" | "autocomplete", value: string): unknown | null {
  const query = value.toLocaleLowerCase("en-US");
  const matches = CURATED_PLACES.filter(place => place.aliases.some(alias =>
    alias === query || (path === "autocomplete" && query.length >= 3 && alias.startsWith(query))
  )).slice(0, path === "autocomplete" ? 8 : 1);
  if (matches.length === 0) return null;
  return {
    type: "FeatureCollection",
    degradedMode: true,
    source: "nyc-parking-planner-curated-fallback",
    features: matches.map(place => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: place.coordinates },
      properties: {
        label: place.label,
        name: place.label,
        precision: place.precision,
        degradedMode: true
      }
    }))
  };
}

async function json(url: URL, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.nycAppToken && url.hostname.endsWith("cityofnewyork.us")) headers["X-App-Token"] = config.nycAppToken;
  const response = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}

async function fetchSearch(path: "search" | "autocomplete", value: string, signal: AbortSignal): Promise<unknown> {
  const url = new URL(`${config.geoSearchBaseUrl}/${path}`);
  url.searchParams.set("text", value);
  url.searchParams.set("size", path === "autocomplete" ? "8" : "5");
  return json(url, signal);
}

async function proxySearch(path: "search" | "autocomplete", value: string): Promise<unknown> {
  const normalized = value.trim().replace(/\s+/g, " ");
  const key = `${path}:${normalized.toLocaleLowerCase("en-US")}`;
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  if (cached) searchCache.delete(key);
  const curated = curatedSearchPayload(path, normalized);
  if (curated) {
    searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, payload: curated });
    return curated;
  }
  const existingRequest = searchInFlight.get(key);
  if (existingRequest) return existingRequest;

  const request = (async () => {
    const deadline = AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS);
    let payload: unknown;
    let usedPreciseFallback = false;
    try {
      payload = await fetchSearch(path, normalized, deadline);
    } catch (error) {
      if (path !== "autocomplete" || deadline.aborted) throw error;
      // Autocomplete is an optimization. A quick upstream error can fall back
      // to precise search, while one shared deadline prevents a 16-second wait.
      payload = await fetchSearch("search", normalized, deadline);
      usedPreciseFallback = true;
    }

    if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = searchCache.keys().next().value as string | undefined;
      if (oldest) searchCache.delete(oldest);
    }
    const cacheEntry = { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, payload };
    searchCache.set(key, cacheEntry);
    if (usedPreciseFallback) {
      searchCache.set(`search:${normalized.toLocaleLowerCase("en-US")}`, cacheEntry);
    }
    return payload;
  })();

  searchInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (searchInFlight.get(key) === request) searchInFlight.delete(key);
  }
}

router.get("/search/autocomplete", async (req, res) => {
  const parsed = autocompleteQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_query" });
  try { res.json(await proxySearch("autocomplete", parsed.data.q)); }
  catch { res.status(502).json({ error: "geosearch_unavailable" }); }
});

router.get("/search", async (req, res) => {
  const parsed = textQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_query" });
  try { res.json(await proxySearch("search", parsed.data.text)); }
  catch { res.status(502).json({ error: "geosearch_unavailable" }); }
});

router.get("/hydrants/viewport", async (req, res) => {
  const parsed = viewportQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_bounds" });
  const q = parsed.data;
  const url = new URL(`${config.nycBaseUrl}/${config.nycHydrantDatasetId}.geojson`);
  url.searchParams.set("$limit", "1000");
  url.searchParams.set("$where", `within_box(the_geom, ${q.maxLat}, ${q.minLng}, ${q.minLat}, ${q.maxLng})`);
  try {
    const payload = await json(url) as { type?: string; features?: GeoJsonFeature[] };
    const sourceFeatures = payload.features ?? [];
    const features = sourceFeatures.flatMap(hydrantFeatures);
    res.json({
      type: "FeatureCollection",
      generatedAt: new Date().toISOString(),
      features,
      hydrantCount: features.filter(feature => feature.properties?.kind === "hydrant").length,
      restrictionDistanceMeters: HYDRANT_RESTRICTION_RADIUS_METERS,
      restrictionGeometry: {
        state: "advisory",
        type: "approximate_radius_buffer",
        radiusMeters: HYDRANT_RESTRICTION_RADIUS_METERS,
        curbLinked: false
      },
      source: "NYCDEP Citywide Hydrants",
      sourceMetadata: {
        agency: "NYC DEP",
        datasetId: config.nycHydrantDatasetId,
        datasetName: "Citywide Hydrants"
      },
      advisory: "Red circles show an approximate 15-foot radius around authoritative hydrant points. They are not DOT-validated curb extents; verify the physical hydrant, curb, and posted signs."
    });
  } catch { res.status(502).json({ error: "hydrants_unavailable" }); }
});

router.get("/facilities", async (req, res) => {
  if (!config.features.garages) {
    return void res.status(503).json({ error: "feature_unavailable", feature: "garages" });
  }
  const parsed = nearQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_location" });
  const { lat, lng, radius } = parsed.data;
  try {
    const dataStatus = await getDataStatus();
    const status = dataStatus.datasets.find(dataset => dataset.dataset === "facilities");
    const authority = dataStatus.authorityGates.find(gate => gate.decisionKey === "facility-directory-use");
    if (authority?.usable !== true) {
      return void res.status(503).json({
        error: "facility_authority_pending",
        ownerAgency: authority?.ownerAgency ?? "NYC DCWP"
      });
    }
    if (status?.state !== "fresh") {
      return void res.status(503).json({
        error: "facility_data_unavailable",
        state: status?.state ?? "missing",
        maxAgeHours: status?.maxAgeHours ?? 14 * 24
      });
    }
    const facilities = await fetchGaragesNear(lat, lng, radius);
    res.json({
      generatedAt: new Date().toISOString(),
      source: {
        agency: "NYC DCWP",
        datasetId: config.nycGarageDatasetId,
        datasetName: "Issued Licenses",
        version: status.version,
        sourceUpdatedAt: status.sourceUpdatedAt,
        filters: ["business_category=Garage & Parking Lot", "license_status=Active"]
      },
      disclaimer: "Active licensed facilities directory only. Pricing, capacity, and space availability are not provided.",
      facilities
    });
  } catch { res.status(502).json({ error: "garages_unavailable" }); }
});

export default router;

export const externalRouteInternals = {
  clearSearchCache: () => {
    searchCache.clear();
    searchInFlight.clear();
  },
  curatedSearchPayload,
  hydrantFeatures,
  restrictionRing
};
