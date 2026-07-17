import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server";

describe("parking viewport validation", () => {
  it("rejects city-scale curb requests", async () => {
    const response = await request(createApp()).get("/api/parking/viewport").query({
      minLat: 40.5, minLng: -74.2, maxLat: 40.9, maxLng: -73.7
    });
    expect(response.status).toBe(400);
  });

  it("requires a complete proximity scope", async () => {
    const response = await request(createApp()).get("/api/parking/viewport").query({
      minLat: 40.74, minLng: -74.0, maxLat: 40.76, maxLng: -73.98,
      centerLat: 40.75, centerLng: -73.99
    });
    expect(response.status).toBe(400);
  });
});
