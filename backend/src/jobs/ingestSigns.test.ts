import { describe, expect, it } from "vitest";
import { signIngestionInternals } from "./ingestSigns";

describe("NYC parking-sign snapshot staging", () => {
  it("normalizes a current sign into a stable blockface record", () => {
    const row = signIngestionInternals.toSignStageRow({
      borough: "Manhattan",
      on_street: "Broadway",
      from_street: "West 33 Street",
      to_street: "West 34 Street",
      side_of_street: "W",
      order_number: "M-100",
      record_type: "Current",
      sign_code: "NP",
      sign_description: "NO PARKING MON-FRI 8AM-6PM",
      order_completed_on_date: "2026-07-01T00:00:00.000",
      order_type: "P-",
      sign_location: "NW",
      distance_from_intersection: "42",
      arrow_direction: "E",
      facing_direction: "S",
      sign_x_coord: "996877",
      sign_y_coord: "222815"
    });

    expect(row).toMatchObject({
      blockfaceKey: "MANHATTAN|BROADWAY|WEST 33 STREET|WEST 34 STREET|W",
      orderNumber: "M-100",
      recordType: "Current",
      signCode: "NP",
      signDescription: "NO PARKING MON-FRI 8AM-6PM",
      orderCompletedOnDate: "2026-07-01",
      orderType: "P-",
      signLocation: "NW",
      distanceFromIntersection: 42,
      arrowDirection: "E",
      facingDirection: "S",
      signXCoord: 996877,
      signYCoord: 222815
    });
    expect(row?.fingerprint).toMatch(/^[a-f0-9]{40}$/);
  });

  it("keeps otherwise identical physical signs distinct by position", () => {
    const base = {
      borough: "Manhattan", on_street: "Broadway", from_street: "West 33 Street",
      to_street: "West 34 Street", side_of_street: "W", order_number: "M-100",
      record_type: "Current", sign_code: "NP", sign_description: "NO PARKING",
      sign_x_coord: "996877", sign_y_coord: "222815"
    };
    const first = signIngestionInternals.toSignStageRow({ ...base, distance_from_intersection: "20" });
    const second = signIngestionInternals.toSignStageRow({ ...base, distance_from_intersection: "80" });
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });

  it("rejects signs without a usable street identity", () => {
    expect(signIngestionInternals.toSignStageRow({
      borough: "Manhattan",
      record_type: "Current",
      sign_description: "NO PARKING"
    })).toBeNull();
  });
});
