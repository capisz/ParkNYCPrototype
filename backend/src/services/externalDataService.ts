import { config } from "../config";
import { dbQuery } from "../db";

export type GarageFacility = {
  id: string;
  name: string;
  legalName: string;
  dbaName: string | null;
  address: string;
  latitude: number;
  longitude: number;
  phone: string | null;
  licenseNumber: string;
  licenseStatus: "Active";
  licenseExpiresAt: string | null;
  facilityDetails: string | null;
};

export type SubwayStation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  routes: string[];
};

async function json(url: URL): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.nycAppToken && url.hostname.endsWith("cityofnewyork.us")) {
    headers["X-App-Token"] = config.nycAppToken;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}

function bounds(lat: number, lng: number, radius: number) {
  const latDelta = radius / 111320;
  const lngDelta = radius / (111320 * Math.max(Math.cos(lat * Math.PI / 180), 0.2));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta
  };
}

export async function fetchGaragesNear(lat: number, lng: number, radius: number): Promise<GarageFacility[]> {
  const result = await dbQuery<{
    id: string;
    legal_name: string;
    dba_name: string | null;
    address: string;
    phone: string | null;
    license_number: string;
    license_status: "Active";
    license_expires_at: string | null;
    facility_details: string | null;
    latitude: number;
    longitude: number;
  }>(`
    SELECT f.id::text, f.legal_name, f.dba_name, f.address, f.phone,
      f.license_number, f.license_status, f.license_expires_at::text,
      f.facility_details, ST_Y(f.geom) AS latitude, ST_X(f.geom) AS longitude
    FROM licensed_facilities f
    JOIN ingestion_runs r ON r.id = f.source_run_id
    WHERE f.license_status = 'Active'
      AND r.status = 'published'
      AND r.source_updated_at IS NOT NULL
      AND r.source_updated_at >= now() - interval '14 days'
      AND ST_DWithin(
        f.geom::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        $3
      )
    ORDER BY f.geom <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)
    LIMIT 500
  `, [lat, lng, radius]);
  return result.rows.map(row => ({
    id: row.id,
    name: row.dba_name ?? row.legal_name,
    legalName: row.legal_name,
    dbaName: row.dba_name,
    address: row.address,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    phone: row.phone,
    licenseNumber: row.license_number,
    licenseStatus: "Active",
    licenseExpiresAt: row.license_expires_at,
    facilityDetails: row.facility_details
  }));
}

export async function fetchSubwayStationsNear(lat: number, lng: number, radius: number): Promise<SubwayStation[]> {
  const url = new URL(`${config.mtaBaseUrl}/${config.mtaSubwayEntrancesDatasetId}.json`);
  const box = bounds(lat, lng, radius);
  url.searchParams.set("$limit", "5000");
  url.searchParams.set("$where", `entry_allowed='YES' AND entrance_latitude between ${box.minLat} and ${box.maxLat} AND entrance_longitude between ${box.minLng} and ${box.maxLng}`);
  const rows = await json(url) as Array<Record<string, unknown>>;
  const stations = new Map<string, SubwayStation>();

  for (const row of rows) {
    const latitude = Number(row.entrance_latitude);
    const longitude = Number(row.entrance_longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const id = String(row.complex_id ?? row.station_id ?? `${latitude}-${longitude}`);
    const routes = String(row.daytime_routes ?? "").split(/\s+/).filter(Boolean);
    const existing = stations.get(id);
    if (!existing) {
      stations.set(id, {
        id,
        name: String(row.stop_name ?? row.constituent_station_name ?? "Subway station"),
        latitude,
        longitude,
        routes
      });
    } else {
      existing.routes = [...new Set([...existing.routes, ...routes])];
    }
  }

  return [...stations.values()];
}
