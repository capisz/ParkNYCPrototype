import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { getCurbParkingDetail, getDataStatus, getViewportParking } from "../services/parkingService";
import { getParkingRecommendations } from "../services/recommendationService";

const router = Router();

const coordinateSchema = z.object({
  latitude: z.number().min(40).max(41.5),
  longitude: z.number().min(-75).max(-73),
  label: z.string().trim().max(240).optional()
});

const intervalFields = z.object({
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true })
}).superRefine((value, context) => {
  const start = Date.parse(value.start);
  const end = Date.parse(value.end);
  if (end <= start) {
    context.addIssue({ code: "custom", path: ["end"], message: "End must be after start." });
  }
  if (end - start > 7 * 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", path: ["end"], message: "Parking intervals cannot exceed seven days." });
  }
});

const viewportQuerySchema = z.object({
  minLat: z.coerce.number().min(40).max(41.5),
  minLng: z.coerce.number().min(-75).max(-73),
  maxLat: z.coerce.number().min(40).max(41.5),
  maxLng: z.coerce.number().min(-75).max(-73),
  centerLat: z.coerce.number().min(40).max(41.5).optional(),
  centerLng: z.coerce.number().min(-75).max(-73).optional(),
  radiusMeters: z.coerce.number().min(100).max(1_500).optional(),
  zoom: z.coerce.number().min(15).max(22).optional(),
  detail: z.enum(["map", "full"]).default("full"),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true })
}).superRefine((value, context) => {
  if (value.minLat >= value.maxLat) context.addIssue({ code: "custom", path: ["minLat"], message: "minLat must be less than maxLat." });
  if (value.minLng >= value.maxLng) context.addIssue({ code: "custom", path: ["minLng"], message: "minLng must be less than maxLng." });
  if (value.maxLat - value.minLat > 0.08 || value.maxLng - value.minLng > 0.1) {
    context.addIssue({ code: "custom", path: ["maxLat"], message: "Viewport is too large. Zoom in before requesting curb data." });
  }
  const proximity = [value.centerLat, value.centerLng, value.radiusMeters, value.zoom];
  if (!proximity.every(item => item === undefined) && !proximity.every(item => item !== undefined)) {
    context.addIssue({ code: "custom", path: ["centerLat"], message: "Proximity scope must include center, radius, and zoom." });
  }
  if (value.centerLat != null && (
    value.centerLat < value.minLat || value.centerLat > value.maxLat ||
    value.centerLng! < value.minLng || value.centerLng! > value.maxLng
  )) {
    context.addIssue({ code: "custom", path: ["centerLat"], message: "Proximity center must be inside the viewport." });
  }
  const interval = intervalFields.safeParse({ start: value.start, end: value.end });
  if (!interval.success) {
    for (const issue of interval.error.issues) context.addIssue(issue);
  }
});

const planSchema = z.object({
  origin: coordinateSchema.nullable().optional(),
  destination: coordinateSchema,
  arriveBy: z.string().datetime({ offset: true }),
  leaveAt: z.string().datetime({ offset: true }),
  preferences: z.object({
    allowPaid: z.boolean().default(true),
    includeGarages: z.boolean().default(true),
    maxWalkMinutes: z.number().int().min(5).max(20).default(10),
    transit: z.boolean().default(false),
    accessibleOnly: z.boolean().default(false),
    transitModes: z.array(z.enum(["SUBWAY", "BUS", "SIR", "LIRR", "METRO_NORTH"]))
      .default(["SUBWAY", "BUS", "SIR", "LIRR", "METRO_NORTH"])
  }).default({
    allowPaid: true,
    includeGarages: true,
    maxWalkMinutes: 10,
    transit: false,
    accessibleOnly: false,
    transitModes: ["SUBWAY", "BUS", "SIR", "LIRR", "METRO_NORTH"]
  })
}).superRefine((value, context) => {
  const interval = intervalFields.safeParse({ start: value.arriveBy, end: value.leaveAt });
  if (!interval.success) {
    for (const issue of interval.error.issues) context.addIssue({ ...issue, path: issue.path[0] === "start" ? ["arriveBy"] : ["leaveAt"] });
  }
  if (value.preferences.transit && !value.origin) {
    context.addIssue({ code: "custom", path: ["origin"], message: "Origin is required for round-trip park-and-ride." });
  }
});

function intervalWithinPlanningWindow(start: Date, end: Date): string | null {
  const now = Date.now();
  if (start.getTime() < now - 60 * 60 * 1_000) return "Start cannot be more than one hour in the past.";
  if (start.getTime() > now + 30 * 24 * 60 * 60 * 1_000) return "Start must be within the next 30 days.";
  if (end <= start) return "End must be after start.";
  return null;
}

router.get("/curb/viewport", async (req, res) => {
  if (!config.features.curbGuidance) {
    return void res.status(503).json({ error: "feature_unavailable", feature: "curbGuidance" });
  }
  const parsed = viewportQuerySchema.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() });
  const start = new Date(parsed.data.start);
  const end = new Date(parsed.data.end);
  const intervalError = intervalWithinPlanningWindow(start, end);
  if (intervalError) return void res.status(400).json({ error: "invalid_interval", message: intervalError });
  try {
    const startedAt = performance.now();
    const payload = await getViewportParking({ ...parsed.data, start, end });
    res.setHeader("cache-control", "private, max-age=20, stale-while-revalidate=40");
    res.setHeader("server-timing", `curb;dur=${(performance.now() - startedAt).toFixed(1)}`);
    res.type("application/geo+json").json(payload);
  } catch (error) {
    console.error("[api/v1/curb/viewport] failed", error);
    res.status(500).json({ error: "curb_data_unavailable" });
  }
});

router.get("/curb/:segmentId", async (req, res) => {
  const segmentId = z.string().uuid().safeParse(req.params.segmentId);
  const interval = intervalFields.safeParse(req.query);
  if (!segmentId.success || !interval.success) {
    return void res.status(400).json({
      error: "invalid_curb_detail",
      details: {
        segmentId: segmentId.success ? undefined : segmentId.error.flatten(),
        interval: interval.success ? undefined : interval.error.flatten()
      }
    });
  }
  const start = new Date(interval.data.start);
  const end = new Date(interval.data.end);
  const intervalError = intervalWithinPlanningWindow(start, end);
  if (intervalError) return void res.status(400).json({ error: "invalid_interval", message: intervalError });
  try {
    const startedAt = performance.now();
    const feature = await getCurbParkingDetail(segmentId.data, start, end);
    if (!feature) return void res.status(404).json({ error: "curb_not_found" });
    res.setHeader("cache-control", "private, max-age=20, stale-while-revalidate=40");
    res.setHeader("server-timing", `curb-detail;dur=${(performance.now() - startedAt).toFixed(1)}`);
    res.type("application/geo+json").json(feature);
  } catch (error) {
    console.error("[api/v1/curb/:segmentId] failed", error);
    res.status(500).json({ error: "curb_detail_unavailable" });
  }
});

router.post("/plans", async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_plan", details: parsed.error.flatten() });
  const arrival = new Date(parsed.data.arriveBy);
  const departure = new Date(parsed.data.leaveAt);
  const intervalError = intervalWithinPlanningWindow(arrival, departure);
  if (intervalError) return void res.status(400).json({ error: "invalid_interval", message: intervalError });
  try {
    const destination = parsed.data.destination;
    res.json(await getParkingRecommendations({
      latitude: destination.latitude,
      longitude: destination.longitude,
      arrival,
      departure,
      allowPaid: parsed.data.preferences.allowPaid,
      allowGarages: parsed.data.preferences.includeGarages,
      maxWalkMinutes: parsed.data.preferences.maxWalkMinutes,
      allowTransit: parsed.data.preferences.transit,
      accessibleOnly: parsed.data.preferences.accessibleOnly,
      origin: parsed.data.origin ?? null
    }));
  } catch (error) {
    console.error("[api/v1/plans] failed", error);
    res.status(500).json({ error: "planning_unavailable" });
  }
});

router.get("/data-status", async (_req, res) => {
  try {
    const payload = await getDataStatus();
    res.setHeader("cache-control", "public, max-age=15, stale-while-revalidate=45");
    res.json(payload);
  } catch (error) {
    console.error("[api/v1/data-status] failed", error);
    res.status(503).json({ error: "data_status_unavailable" });
  }
});

export default router;
