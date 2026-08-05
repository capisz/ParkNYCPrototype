import { config } from "../config";
import { fetchGaragesNear, GarageFacility } from "./externalDataService";
import { getParkingCalendarContext, parkingCalendarWarnings } from "./parkingCalendarService";
import { getDataStatus, getViewportParking, ViewportFeature } from "./parkingService";
import { getTransitCapability } from "./transitService";

export type RecommendationPreferences = {
  latitude: number;
  longitude: number;
  arrival: Date;
  departure: Date;
  allowPaid: boolean;
  allowGarages: boolean;
  maxWalkMinutes: number;
  allowTransit: boolean;
  accessibleOnly: boolean;
  origin: { latitude: number; longitude: number; label?: string } | null;
};

export type RecommendationOption = {
  id: string;
  kind: "curb" | "licensed_facility" | "park_and_ride";
  tier: "free" | "paid" | "facility" | "park_and_ride";
  status: "free" | "paid";
  title: string;
  subtitle: string;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  walkMinutes: number;
  confidence: number | null;
  coverage: "full";
  score: number;
  ruleSummary: string;
  nextChange: string | null;
  sourceVersion: string | null;
  facility: null | Pick<GarageFacility,
    "legalName" | "dbaName" | "licenseNumber" | "licenseStatus" | "licenseExpiresAt" | "facilityDetails">;
  transit: null | {
    state: "live" | "scheduled";
    realtimeAsOf: string | null;
    legs: Array<Record<string, unknown>>;
  };
  guidanceLevel: "approved_curb" | "public_data_reference" | "licensed_facility" | "transit";
};

const WALKING_METERS_PER_MINUTE = 80;

export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitude1 = radians(a.latitude);
  const latitude2 = radians(b.latitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = radians(b.longitude - a.longitude);
  const value = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function midpoint(geometry: ViewportFeature["geometry"]): { latitude: number; longitude: number } | null {
  let coordinates: number[][] = [];
  if (geometry.type === "LineString") coordinates = geometry.coordinates as number[][];
  if (geometry.type === "MultiLineString") {
    const lines = geometry.coordinates as number[][][];
    coordinates = [...lines].sort((a, b) => b.length - a.length)[0] ?? [];
  }
  if (coordinates.length === 0) return null;
  const pair = coordinates[Math.floor(coordinates.length / 2)];
  return pair?.length >= 2 ? { latitude: pair[1], longitude: pair[0] } : null;
}

export function rankRecommendations(options: RecommendationOption[]): RecommendationOption[] {
  const tierPriority: Record<RecommendationOption["tier"], number> = {
    free: 0,
    paid: 1,
    facility: 2,
    park_and_ride: 3
  };
  return [...options].sort((a, b) =>
    tierPriority[a.tier] - tierPriority[b.tier] ||
    a.score - b.score ||
    a.walkMinutes - b.walkMinutes ||
    (b.confidence ?? 0) - (a.confidence ?? 0) ||
    a.title.localeCompare(b.title)
  );
}

export function curbOption(feature: ViewportFeature, destination: { latitude: number; longitude: number }): RecommendationOption | null {
  const status = feature.properties.status;
  if ((status !== "free" && status !== "paid") || feature.properties.coverage !== "full") return null;
  const approvedCurb = feature.properties.geometryValidated && feature.properties.recommendationEligible;
  const publicDataReference = feature.properties.geometryBasis === "official_meter_blockface";
  if (!approvedCurb && !publicDataReference) return null;
  const point = midpoint(feature.geometry);
  if (!point) return null;
  const distance = distanceMeters(destination, point);
  const walkMinutes = Math.max(1, Math.ceil(distance / WALKING_METERS_PER_MINUTE));
  const confidence = feature.properties.confidence;
  return {
    id: String(feature.id),
    kind: "curb",
    tier: status,
    status,
    title: feature.properties.onStreet ?? "NYC curb",
    subtitle: [
      feature.properties.sideOfStreet ? `${feature.properties.sideOfStreet} side` : null,
      [feature.properties.fromStreet, feature.properties.toStreet].filter(Boolean).join(" to "),
      publicDataReference ? "Official NYC meter blockface reference" : null
    ].filter(Boolean).join(" · ") || "Street parking",
    latitude: point.latitude,
    longitude: point.longitude,
    distanceMeters: Math.round(distance),
    walkMinutes,
    confidence,
    coverage: "full",
    score: walkMinutes * 4 + (status === "paid" ? 8 : 0) + (1 - confidence) * 25,
    ruleSummary: feature.properties.ruleSummary,
    nextChange: feature.properties.nextChange,
    sourceVersion: feature.properties.sourceVersion,
    facility: null,
    transit: null,
    guidanceLevel: publicDataReference ? "public_data_reference" : "approved_curb"
  };
}

function facilityOption(garage: GarageFacility, destination: { latitude: number; longitude: number }): RecommendationOption {
  const distance = distanceMeters(destination, garage);
  const walkMinutes = Math.max(1, Math.ceil(distance / WALKING_METERS_PER_MINUTE));
  return {
    id: `facility-${garage.id}`,
    kind: "licensed_facility",
    tier: "facility",
    status: "paid",
    title: garage.name,
    subtitle: garage.address,
    latitude: garage.latitude,
    longitude: garage.longitude,
    distanceMeters: Math.round(distance),
    walkMinutes,
    confidence: null,
    coverage: "full",
    score: walkMinutes * 4 + 12,
    ruleSummary: "Active NYC DCWP garage or parking-lot license. Pricing, capacity, and space availability are not provided.",
    nextChange: null,
    sourceVersion: config.nycGarageDatasetId,
    facility: {
      legalName: garage.legalName,
      dbaName: garage.dbaName,
      licenseNumber: garage.licenseNumber,
      licenseStatus: garage.licenseStatus,
      licenseExpiresAt: garage.licenseExpiresAt,
      facilityDetails: garage.facilityDetails
    },
    transit: null,
    guidanceLevel: "licensed_facility"
  };
}

export async function getParkingRecommendations(preferences: RecommendationPreferences) {
  const warnings: Array<{ code: string; message: string }> = [];
  const dataStatus = await getDataStatus();
  const parkingCalendar = getParkingCalendarContext(preferences.arrival, preferences.departure);
  warnings.push(...parkingCalendarWarnings(preferences.arrival, preferences.departure));
  const unavailableCurbSources = dataStatus.datasets
    .filter(dataset => ["geometry", "meters", "signs"].includes(dataset.dataset) && dataset.state !== "fresh")
    .map(dataset => dataset.dataset);
  if (unavailableCurbSources.length > 0) {
    warnings.push({
      code: "curb_sources_not_ready",
      message: `Approved curb geometry is not ready (${unavailableCurbSources.join(", ")}). Pidge may rank fully resolved official meter blockfaces as public-data leads, but each one requires an on-street sign and curb check.`
    });
  }
  const preferredWalkRadius = Math.max(400, Math.min(1_500, preferences.maxWalkMinutes * WALKING_METERS_PER_MINUTE));
  const loadParking = async (radiusMeters: number) => {
    const latDelta = radiusMeters / 111_320;
    const lngDelta = radiusMeters / (111_320 * Math.max(Math.cos(preferences.latitude * Math.PI / 180), 0.2));
    return getViewportParking({
      minLat: preferences.latitude - latDelta,
      minLng: preferences.longitude - lngDelta,
      maxLat: preferences.latitude + latDelta,
      maxLng: preferences.longitude + lngDelta,
      centerLat: preferences.latitude,
      centerLng: preferences.longitude,
      radiusMeters,
      zoom: 16,
      start: preferences.arrival,
      end: preferences.departure
    });
  };
  let searchRadiusMeters = preferredWalkRadius;
  let parking = config.features.curbGuidance ? await loadParking(preferredWalkRadius) : {
    features: [] as ViewportFeature[],
    summary: { cannotPark: 0, paid: 0, free: 0, unknown: 0 }
  };

  const destination = { latitude: preferences.latitude, longitude: preferences.longitude };
  const eligibleCurbOptions = (features: ViewportFeature[]) => features
    .map(feature => curbOption(feature, destination))
    .filter((option): option is RecommendationOption => option != null)
    .filter(option => option.status === "free" || preferences.allowPaid);
  let options = eligibleCurbOptions(parking.features);

  // A zero-result screen is not useful. Search up to a 19-minute walking ring
  // and label the result as an expanded fallback instead of weakening the
  // classification rules or fabricating green curbs near the destination.
  if (config.features.curbGuidance && options.length === 0 && preferredWalkRadius < 1_500) {
    const expandedParking = await loadParking(1_500);
    const expandedOptions = eligibleCurbOptions(expandedParking.features);
    if (expandedOptions.length > 0) {
      parking = expandedParking;
      options = expandedOptions;
      searchRadiusMeters = 1_500;
      warnings.push({
        code: "walking_area_expanded",
        message: `No free or paid curb lead matched the preferred ${preferences.maxWalkMinutes}-minute walk. Pidge expanded the search to about 19 minutes and ranked the closest supported alternatives.`
      });
    }
  }

  if (!config.features.curbGuidance) {
    warnings.push({ code: "curb_guidance_disabled", message: "Curb guidance is disabled pending its release gate." });
  } else if (options.length === 0 && parking.summary.unknown > 0) {
    warnings.push({
      code: "curb_guidance_unknown",
      message: "Nearby curb evidence or geometry is unresolved. Gray curbs are not recommendations."
    });
  }

  if (preferences.allowGarages) {
    if (!config.features.garages) {
      warnings.push({ code: "facilities_disabled", message: "Licensed facilities are disabled pending their release gate." });
    } else {
      const facilityStatus = dataStatus.datasets.find(dataset => dataset.dataset === "facilities");
      const facilityAuthority = dataStatus.authorityGates.find(gate => gate.decisionKey === "facility-directory-use");
      if (facilityAuthority?.usable !== true) {
        warnings.push({
          code: "facilities_authority_pending",
          message: "The licensed-facility directory is unavailable pending NYC DCWP data-steward approval."
        });
      } else if (facilityStatus?.state !== "fresh") {
        warnings.push({
          code: "facilities_stale",
          message: "The active licensed-facility directory is outside its 14-day freshness gate and is unavailable."
        });
      } else {
        const garages = await fetchGaragesNear(
          preferences.latitude,
          preferences.longitude,
          searchRadiusMeters
        ).catch(() => []);
        options.push(...garages.map(garage => facilityOption(garage, destination)));
      }
    }
  }

  const transitCapability = getTransitCapability();
  if (preferences.allowTransit) {
    if (!preferences.origin) {
      warnings.push({ code: "origin_required", message: "A starting point is required for round-trip park-and-ride." });
    } else if (transitCapability.state !== "available") {
      warnings.push({ code: "transit_unavailable", message: transitCapability.message });
    } else {
      warnings.push({
        code: "transit_candidate_pipeline_pending",
        message: "Transit routing is connected, but park-and-ride candidates remain disabled until the validation corpus passes."
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    interval: { start: preferences.arrival.toISOString(), end: preferences.departure.toISOString() },
    timezone: config.timezone,
    advisory: true,
    preferences: {
      allowPaid: preferences.allowPaid,
      allowGarages: preferences.allowGarages,
      maxWalkMinutes: preferences.maxWalkMinutes,
      allowTransit: preferences.allowTransit,
      accessibleOnly: preferences.accessibleOnly
    },
    capabilities: {
      curbGuidance: config.features.curbGuidance,
      garages: config.features.garages,
      transit: transitCapability
    },
    dataVersions: dataStatus.datasets.map(dataset => ({
      dataset: dataset.dataset,
      datasetId: dataset.datasetId,
      version: dataset.version,
      sourceUpdatedAt: dataset.sourceUpdatedAt,
      state: dataset.state
    })),
    parkingCalendar,
    availability: parking.summary,
    options: rankRecommendations(options).slice(0, 20),
    preferredRadiusMeters: preferredWalkRadius,
    searchRadiusMeters,
    warnings,
    disclaimer: "Advisory guidance only. Check posted signs, meter or ParkNYC instructions, facility terms, and current transit conditions. A result does not guarantee an open physical space."
  };
}
