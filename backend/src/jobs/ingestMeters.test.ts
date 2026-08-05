import { describe, expect, it } from "vitest";
import { meterIngestionInternals } from "./ingestMeters";

describe("ParkNYC meter blockface ingestion", () => {
  it("normalizes an official multiline row into one staged blockface", () => {
    const row = meterIngestionInternals.toMeterStageRow({
      borough: "Manhattan",
      on_street: "Broadway",
      from_stree: "West 33 Street",
      to_street: "West 34 Street",
      side_of_st: "W",
      meter_rate: "Zone M1",
      all_vehi_1: "Monday-Saturday 9 AM-7 PM",
      pay_by_cel: "123456",
      the_geom: {
        type: "MultiLineString",
        coordinates: [
          [[-73.99, 40.75], [-73.98, 40.76]],
          [[-73.97, 40.74], [-73.96, 40.75], [-73.95, 40.76]]
        ]
      }
    });

    expect(row).toMatchObject({
      blockfaceKey: "MANHATTAN|BROADWAY|WEST 33 STREET|WEST 34 STREET|W",
      sideOfStreet: "W",
      paidHours: "Monday-Saturday 9 AM-7 PM",
      meterRate: "Zone M1",
      geomWkt: "LINESTRING(-73.97 40.74, -73.96 40.75, -73.95 40.76)"
    });
  });

  it("rejects rows without usable street identity or line geometry", () => {
    expect(meterIngestionInternals.toMeterStageRow({
      borough: "Manhattan",
      the_geom: { type: "LineString", coordinates: [[-73.99, 40.75], [-73.98, 40.76]] }
    })).toBeNull();
    expect(meterIngestionInternals.toMeterStageRow({
      borough: "Manhattan", on_street: "Broadway",
      the_geom: { type: "Point", coordinates: [-73.99, 40.75] }
    })).toBeNull();
  });
});
