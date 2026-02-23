import { Router } from "express";
import { z } from "zod";
import { getViewportParking } from "../services/parkingService";

const router = Router();

const viewportQuerySchema = z
  .object({
    minLat: z.coerce.number().min(40.0).max(41.5),
    minLng: z.coerce.number().min(-75.0).max(-73.0),
    maxLat: z.coerce.number().min(40.0).max(41.5),
    maxLng: z.coerce.number().min(-75.0).max(-73.0),
    asOf: z.string().optional()
  })
  .refine((value) => value.minLat < value.maxLat, {
    message: "minLat must be less than maxLat"
  })
  .refine((value) => value.minLng < value.maxLng, {
    message: "minLng must be less than maxLng"
  });

router.get("/viewport", async (req, res) => {
  const parsed = viewportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid query parameters",
      details: parsed.error.flatten()
    });
    return;
  }

  let asOf: Date | undefined;
  if (parsed.data.asOf) {
    const parsedDate = new Date(parsed.data.asOf);
    if (Number.isNaN(parsedDate.getTime())) {
      res.status(400).json({
        error: "Invalid 'asOf' value. Use an ISO timestamp."
      });
      return;
    }
    asOf = parsedDate;
  }

  try {
    const payload = await getViewportParking({
      minLat: parsed.data.minLat,
      minLng: parsed.data.minLng,
      maxLat: parsed.data.maxLat,
      maxLng: parsed.data.maxLng,
      asOf
    });

    res.json(payload);
  } catch (error) {
    console.error("[api/parking/viewport] failed", error);
    res.status(500).json({
      error: "Failed to load parking viewport data"
    });
  }
});

export default router;
