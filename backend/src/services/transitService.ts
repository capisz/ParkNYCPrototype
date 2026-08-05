import { config } from "../config";

export type TransitCapability =
  | { state: "available"; realtime: true; provider: "OpenTripPlanner 2.9" }
  | { state: "disabled" | "unconfigured"; realtime: false; message: string };

export function getTransitCapability(): TransitCapability {
  if (!config.features.transit) {
    return {
      state: "disabled",
      realtime: false,
      message: "Round-trip park-and-ride is held behind its pilot safety gate."
    };
  }
  if (!config.otpBaseUrl) {
    return {
      state: "unconfigured",
      realtime: false,
      message: "OpenTripPlanner has not been configured for this environment."
    };
  }
  return { state: "available", realtime: true, provider: "OpenTripPlanner 2.9" };
}
