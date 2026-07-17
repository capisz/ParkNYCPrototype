import { Router } from "express";
import { z } from "zod";
import { config } from "../config";

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
    const payload = await json(url) as Record<string, unknown>;
    res.json({ ...payload, restrictionDistanceMeters: 4.57, source: "NYCDEP Citywide Hydrants" });
  } catch { res.status(502).json({ error: "hydrants_unavailable" }); }
});

router.get("/garages/near", async (req, res) => {
  const parsed = nearQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_location" });
  const { lat, lng, radius } = parsed.data;
  const url = new URL(`${config.nycBaseUrl}/${config.nycGarageDatasetId}.json`);
  url.searchParams.set("$limit", "100");
  url.searchParams.set("$where", `within_circle(location, ${lat}, ${lng}, ${radius})`);
  try {
    const facilities = await json(url);
    res.json({ generatedAt: new Date().toISOString(), source: "NYC DCWP licensed facilities", disclaimer: "Known licensed facilities; availability and pricing are not real-time.", facilities });
  } catch { res.status(502).json({ error: "garages_unavailable" }); }
});

export default router;
