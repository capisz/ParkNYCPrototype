import { describe, expect, it } from "vitest";
import {
  curbOption,
  distanceMeters,
  hasLikelyFreeLead,
  rankRecommendations,
  RecommendationOption
} from "./recommendationService";
import type { ViewportFeature } from "./parkingService";

function option(tier: RecommendationOption["tier"], distance: number, score: number): RecommendationOption {
  const curb = tier === "free" || tier === "paid";
  return {
    id: `${tier}-${distance}`,
    kind: curb ? "curb" : tier === "facility" ? "licensed_facility" : "park_and_ride",
    tier,
    status: tier === "free" ? "free" : "paid",
    title: tier,
    subtitle: "",
    latitude: 40.75,
    longitude: -73.98,
    distanceMeters: distance,
    walkMinutes: 1,
    confidence: curb ? 0.9 : null,
    coverage: "full",
    score,
    ruleSummary: "test",
    nextChange: null,
    sourceVersion: "test",
    facility: null,
    transit: null,
    guidanceLevel: curb ? "approved_curb" : tier === "facility" ? "licensed_facility" : "transit"
  };
}

describe("parking recommendation ranking", () => {
  it("prioritizes free, then paid, then facilities before distance scoring", () => {
    const ranked = rankRecommendations([
      option("free", 900, 40), option("paid", 300, 18), option("facility", 100, 22)
    ]);
    expect(ranked.map(item => item.tier)).toEqual(["free", "paid", "facility"]);
  });

  it("uses walking burden and confidence as deterministic tie breakers", () => {
    const farther = option("free", 600, 20);
    farther.walkMinutes = 8;
    const nearer = option("free", 200, 20);
    nearer.walkMinutes = 3;
    expect(rankRecommendations([farther, nearer]).map(item => item.distanceMeters)).toEqual([200, 600]);
  });

  it("continues the bounded search when the preferred ring contains only paid leads", () => {
    expect(hasLikelyFreeLead([option("paid", 200, 10)])).toBe(false);
    expect(hasLikelyFreeLead([
      option("paid", 200, 10),
      option("free", 900, 40)
    ])).toBe(true);
  });

  it("calculates realistic short geographic distances", () => {
    const distance = distanceMeters(
      { latitude: 40.7484, longitude: -73.9857 },
      { latitude: 40.7494, longitude: -73.9857 }
    );
    expect(distance).toBeGreaterThan(105);
    expect(distance).toBeLessThan(120);
  });

  it("ranks a fully covered official meter blockface as an explicit public-data lead", () => {
    const feature = {
      type: "Feature",
      id: "meter-reference",
      geometry: { type: "LineString", coordinates: [[-73.986, 40.748], [-73.985, 40.748]] },
      properties: {
        status: "free", coverage: "full", confidence: 0.65,
        geometryValidated: false, geometryBasis: "official_meter_blockface",
        recommendationEligible: false, onStreet: "West 34 Street",
        fromStreet: "5 Avenue", toStreet: "6 Avenue", sideOfStreet: "N",
        ruleSummary: "Green means likely free parking for the complete planned interval; verify posted signs.",
        nextChange: null, sourceVersion: "active-meter-run"
      }
    } as ViewportFeature;

    expect(curbOption(feature, { latitude: 40.7484, longitude: -73.9857 })).toMatchObject({
      tier: "free",
      guidanceLevel: "public_data_reference"
    });
  });
});
