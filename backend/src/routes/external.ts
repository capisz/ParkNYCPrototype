import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { pool } from "../db";

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

async function json(url: URL): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.nycAppToken && url.hostname.endsWith("cityofnewyork.us")) headers["X-App-Token"] = config.nycAppToken;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}

function proxySearch(path: "search" | "autocomplete", value: string) {
  const url = new URL(`${config.geoSearchBaseUrl}/${path}`);
  url.searchParams.set("text", value);
  url.searchParams.set("size", path === "autocomplete" ? "8" : "5");
  return json(url);
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
    const payload = await json(url) as { type?: string; features?: Array<Record<string, unknown>> };
    const points: Array<Record<string, unknown>> = (payload.features ?? []).map(feature => ({
      ...feature,
      properties: { ...((feature.properties as Record<string, unknown>) ?? {}), kind: "hydrant" }
    }));
    const coordinates = points.flatMap(feature => {
      const geometry = feature.geometry as { type?: string; coordinates?: unknown } | undefined;
      return geometry?.type === "Point" && Array.isArray(geometry.coordinates) ? [geometry.coordinates] : [];
    });
    let restrictions: unknown[] = [];
    if (coordinates.length > 0) {
      try {
        const result = await pool.query<{ feature: unknown }>(`
        WITH hydrants AS (
          SELECT row_number() OVER () AS id,
            ST_SetSRID(ST_MakePoint((value->>0)::float8, (value->>1)::float8), 4326) AS geom
          FROM jsonb_array_elements($1::jsonb)
        ), nearest AS (
          SELECT h.id, h.geom AS hydrant_geom, s.geom,
            ST_LineLocatePoint(s.geom, h.geom) AS fraction,
            ST_Length(s.geom::geography) AS length_meters
          FROM hydrants h
          CROSS JOIN LATERAL (
            SELECT geom FROM curb_segments
            WHERE ST_DWithin(geom::geography, h.geom::geography, 25)
            ORDER BY geom <-> h.geom LIMIT 1
          ) s
        )
        SELECT jsonb_build_object(
          'type', 'Feature', 'geometry', ST_AsGeoJSON(ST_LineSubstring(
            geom, GREATEST(0, fraction - (4.57 / NULLIF(length_meters, 0))),
            LEAST(1, fraction + (4.57 / NULLIF(length_meters, 0)))
          ))::jsonb,
          'properties', jsonb_build_object('kind', 'hydrant_restriction', 'status', 'no_parking', 'distanceMetersEachSide', 4.57)
        ) AS feature FROM nearest WHERE length_meters > 0
        `, [JSON.stringify(coordinates)]);
        restrictions = result.rows.map(row => row.feature);
      } catch {
        // Hydrant points remain useful when curb geometry is temporarily unavailable.
      }
    }
    res.json({ type: "FeatureCollection", features: [...points, ...restrictions], restrictionDistanceMeters: 4.57, source: "NYCDEP Citywide Hydrants" });
  } catch { res.status(502).json({ error: "hydrants_unavailable" }); }
});

router.get("/garages/near", async (req, res) => {
  const parsed = nearQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_location" });
  const { lat, lng, radius } = parsed.data;
  const url = new URL(`${config.nycBaseUrl}/${config.nycGarageDatasetId}.json`);
  url.searchParams.set("$limit", "100");
  const latDelta = radius / 111320;
  const lngDelta = radius / (111320 * Math.max(Math.cos(lat * Math.PI / 180), 0.2));
  url.searchParams.set("$where", `latitude between ${lat - latDelta} and ${lat + latDelta} AND longitude between ${lng - lngDelta} and ${lng + lngDelta}`);
  try {
    const rows = await json(url) as Array<Record<string, unknown>>;
    const facilities = rows.map(row => ({
      id: row.license_nbr,
      name: row.business_name ?? "Licensed parking facility",
      address: [row.address_building, row.address_street_name, row.address_city].filter(Boolean).join(" "),
      latitude: Number(row.latitude), longitude: Number(row.longitude),
      phone: row.contact_phone ?? null, licenseExpiresAt: row.lic_expir_dd ?? null
    })).filter(row => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
    res.json({ generatedAt: new Date().toISOString(), source: "NYC DCWP licensed facilities", disclaimer: "Known licensed facilities; availability and pricing are not real-time.", facilities });
  } catch { res.status(502).json({ error: "garages_unavailable" }); }
});

export default router;
