import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server";
import { externalRouteInternals } from "./external";

const payload = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: { type: "Point", coordinates: [-73.9654, 40.7829] },
    properties: { label: "Central Park, New York, NY, USA" }
  }]
};

describe("destination search proxy", () => {
  beforeEach(() => externalRouteInternals.clearSearchCache());
  afterEach(() => vi.unstubAllGlobals());

  it("uses the reviewed degraded-mode directory without waiting on the upstream geocoder", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(createApp()).get("/api/v1/search").query({ text: "Downtown   Brooklyn" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      degradedMode: true,
      source: "nyc-parking-planner-curated-fallback"
    });
    expect(response.body.features[0]).toMatchObject({
      geometry: { type: "Point", coordinates: [-73.99, 40.692] },
      properties: { precision: "neighborhood_center", degradedMode: true }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to precise search when autocomplete is temporarily unavailable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(createApp()).get("/api/v1/search/autocomplete").query({ q: "Central Park" });

    expect(response.status).toBe(200);
    expect(response.body.features[0].properties.label).toBe("Central Park, New York, NY, USA");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/autocomplete?");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/search?");
  });

  it("caches repeated normalized searches briefly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp();
    const first = await request(app).get("/api/v1/search").query({ text: "Central   Park" });
    const second = await request(app).get("/api/v1/search").query({ text: " central park " });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent identical searches", async () => {
    let releaseFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>(resolve => {
      releaseFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp();
    const first = request(app).get("/api/v1/search").query({ text: "Central Park" }).then(response => response);
    const second = request(app).get("/api/v1/search").query({ text: "central   park" }).then(response => response);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    releaseFetch?.(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("hydrant viewport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns authoritative points with explicit advisory 15-foot buffer circles", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id: "hydrant-42",
        geometry: { type: "Point", coordinates: [-73.9654, 40.7829] },
        properties: { status: "ACTIVE" }
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/geo+json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(createApp()).get("/api/v1/hydrants/viewport").query({
      minLat: 40.78,
      minLng: -73.97,
      maxLat: 40.79,
      maxLng: -73.96
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      type: "FeatureCollection",
      hydrantCount: 1,
      restrictionDistanceMeters: 4.572,
      restrictionGeometry: {
        state: "advisory",
        type: "approximate_radius_buffer",
        radiusMeters: 4.572,
        curbLinked: false
      },
      sourceMetadata: {
        agency: "NYC DEP",
        datasetId: "5bgh-vtsn",
        datasetName: "Citywide Hydrants"
      }
    });
    const restriction = response.body.features.find((feature: { properties?: { kind?: string } }) =>
      feature.properties?.kind === "hydrant_exclusion"
    );
    const point = response.body.features.find((feature: { properties?: { kind?: string } }) =>
      feature.properties?.kind === "hydrant"
    );
    expect(point).toMatchObject({
      geometry: { type: "Point", coordinates: [-73.9654, 40.7829] },
      properties: { kind: "hydrant", restrictionRadiusMeters: 4.572 }
    });
    expect(restriction).toMatchObject({
      geometry: { type: "Polygon" },
      properties: {
        kind: "hydrant_exclusion",
        legacyKind: "hydrant_restriction",
        parkingStatus: "cannot_park",
        color: "#D3232A",
        restrictionRadiusMeters: 4.572,
        geometryAccuracy: "approximate_radial_buffer",
        curbLinked: false,
        advisory: true
      }
    });
    const ring = restriction.geometry.coordinates[0];
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring.at(-1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/5bgh-vtsn.geojson?");
  });

  it("omits malformed source geometries instead of drawing false restrictions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-73.9654, null] } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(createApp()).get("/api/v1/hydrants/viewport").query({
      minLat: 40.78,
      minLng: -73.97,
      maxLat: 40.79,
      maxLng: -73.96
    });

    expect(response.status).toBe(200);
    expect(response.body.hydrantCount).toBe(0);
    expect(response.body.features).toEqual([]);
  });
});
