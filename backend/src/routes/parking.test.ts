import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server";

const start = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
const end = new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString();

describe("v1 parking API validation", () => {
  it("exposes only minimal public liveness information", async () => {
    const response = await request(createApp()).get("/livez");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, service: "nyc-parking-planner-api" });
  });

  it("protects operational readiness details", async () => {
    const response = await request(createApp()).get("/readyz");
    expect(response.status).toBe(401);
  });

  it("rejects city-scale curb requests", async () => {
    const response = await request(createApp()).get("/api/v1/curb/viewport").query({
      minLat: 40.5, minLng: -74.2, maxLat: 40.9, maxLng: -73.7, start, end
    });
    expect(response.status).toBe(400);
  });

  it("requires a complete proximity scope", async () => {
    const response = await request(createApp()).get("/api/v1/curb/viewport").query({
      minLat: 40.74, minLng: -74.0, maxLat: 40.76, maxLng: -73.98,
      centerLat: 40.75, centerLng: -73.99, start, end
    });
    expect(response.status).toBe(400);
  });

  it("rejects unknown viewport detail modes before querying data", async () => {
    const response = await request(createApp()).get("/api/v1/curb/viewport").query({
      minLat: 40.74, minLng: -74.0, maxLat: 40.76, maxLng: -73.98,
      start, end, detail: "everything"
    });
    expect(response.status).toBe(400);
  });

  it("rejects malformed curb detail identifiers before querying data", async () => {
    const response = await request(createApp()).get("/api/v1/curb/not-a-uuid").query({ start, end });
    expect(response.status).toBe(400);
  });

  it("requires both arrival and leave times for plans", async () => {
    const response = await request(createApp()).post("/api/v1/plans").send({
      destination: { latitude: 40.7484, longitude: -73.9857 },
      arriveBy: start
    });
    expect(response.status).toBe(400);
  });

  it("requires an origin when transit is requested", async () => {
    const response = await request(createApp()).post("/api/v1/plans").send({
      destination: { latitude: 40.7484, longitude: -73.9857 },
      arriveBy: start,
      leaveAt: end,
      preferences: { transit: true }
    });
    expect(response.status).toBe(400);
  });

  it("rejects starts outside the planning window", async () => {
    const lateStart = new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString();
    const lateEnd = new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000 + 60 * 60 * 1_000).toISOString();
    const response = await request(createApp()).post("/api/v1/plans").send({
      destination: { latitude: 40.7484, longitude: -73.9857 },
      arriveBy: lateStart,
      leaveAt: lateEnd
    });
    expect(response.status).toBe(400);
  });
});
