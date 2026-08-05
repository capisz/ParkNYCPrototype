export type MeterGeometryDatasetState = "fresh" | "stale" | "missing" | "failed";

export type MeterGeometryEvidence = {
  source: string;
  reason: string;
  confidence: number;
};

export type MeterGeometryClassification = {
  status: "cannot_park" | "paid" | "free" | "unknown";
  coverage: "full" | "partial" | "none";
  confidence: number;
  evidence: MeterGeometryEvidence[];
};

export type MeterGeometryPilotInput = {
  segmentSource: string;
  configuredDatasetId: string;
  sideOfStreet: string | null;
  paidHours: string | null;
  meterRate: string | null;
  sourceRunId: string | null;
  activeDatasetVersion: string | null;
  datasetState: MeterGeometryDatasetState;
  signsDatasetState: MeterGeometryDatasetState;
  classification: MeterGeometryClassification;
};

export type MeterGeometryPilotDecision = {
  usableForPaidDisplay: boolean;
  usableForProhibitedDisplay: boolean;
  usableForFreeDisplay: boolean;
  usableForReferenceDisplay: boolean;
  displayStatus: "cannot_park" | "paid" | "free" | null;
  geometryBasis: "official_meter_blockface" | "unvalidated";
  recommendationEligible: false;
  reason: string;
  evidence: MeterGeometryEvidence | null;
};

const OFFICIAL_METER_EVIDENCE = "nyc-meters";
const PUBLIC_DATA_FREE_REFERENCE_EVIDENCE = "nyc-sign-meter-free-reference";
const ALLOWED_NON_METER_EVIDENCE = new Set(["nyc-dot-calendar"]);
const CARDINAL_SIDES = new Set(["N", "E", "S", "W"]);
const SUPPORTED_PROHIBITION = /\b(?:NO PARKING|NO STANDING|NO STOPPING|STREET CLEANING|ALTERNATE SIDE|SANITATION|BROOM)\b/i;

function isUsablePaidSchedule(value: string | null): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized.length > 0 && normalized !== "N/A";
}

function isOnStreetMeterRate(value: string | null): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized.length > 0 && normalized !== "N/A" && normalized !== "OFF-STREET PARKING";
}

/**
 * Allows a deliberately narrow pilot visualization from NYC DOT's ParkNYC
 * Block Faces dataset. It can retain a yellow, paid classification only when
 * the active published meter snapshot supplies side-specific geometry and the
 * interval classifier is completely covered by meter evidence.
 *
 * It never validates the line as legal curb geometry and it never makes the
 * feature recommendation-eligible. Green is allowed only as a public-data
 * reference when fresh sign data, a recognized meter schedule, and an
 * explicit full-interval baseline all agree. Incomplete and stale evidence
 * continues through the normal fail-closed policy.
 */
export function evaluateMeterGeometryPilot(input: MeterGeometryPilotInput): MeterGeometryPilotDecision {
  const expectedSource = `meters:${input.configuredDatasetId}`;
  const evidenceSources = input.classification.evidence.map(item => item.source);
  const hasMeterEvidence = evidenceSources.some(source => source === OFFICIAL_METER_EVIDENCE);
  const hasFreeReferenceEvidence = evidenceSources.some(source => source === PUBLIC_DATA_FREE_REFERENCE_EVIDENCE);
  const hasOnlyNarrowEvidence = evidenceSources.every(source =>
    source === OFFICIAL_METER_EVIDENCE || ALLOWED_NON_METER_EVIDENCE.has(source)
  );
  const supportedSignEvidence = input.classification.evidence.filter(item =>
    item.source.startsWith("nyc-signs") && item.confidence >= 0.9 && SUPPORTED_PROHIBITION.test(item.reason)
  );
  const hasOnlySupportedProhibitionEvidence = input.classification.evidence.every(item =>
    item.source === OFFICIAL_METER_EVIDENCE || ALLOWED_NON_METER_EVIDENCE.has(item.source) ||
      supportedSignEvidence.includes(item)
  );
  const sourceVersionIsActive = input.sourceRunId != null &&
    input.activeDatasetVersion != null && input.sourceRunId === input.activeDatasetVersion;

  const usableMeterGeometry = input.segmentSource === expectedSource &&
    input.datasetState === "fresh" &&
    sourceVersionIsActive &&
    CARDINAL_SIDES.has((input.sideOfStreet ?? "").trim().toUpperCase()) &&
    isOnStreetMeterRate(input.meterRate);
  const usableForPaidDisplay = usableMeterGeometry &&
    isUsablePaidSchedule(input.paidHours) &&
    input.classification.status === "paid" &&
    input.classification.coverage === "full" &&
    hasMeterEvidence &&
    hasOnlyNarrowEvidence;
  const usableForProhibitedDisplay = usableMeterGeometry &&
    input.signsDatasetState === "fresh" &&
    input.classification.status === "cannot_park" &&
    input.classification.coverage === "full" &&
    supportedSignEvidence.length > 0 &&
    hasOnlySupportedProhibitionEvidence;
  const hasOnlyFreeReferenceEvidence = input.classification.evidence.every(item =>
    item.source === PUBLIC_DATA_FREE_REFERENCE_EVIDENCE || ALLOWED_NON_METER_EVIDENCE.has(item.source)
  );
  const usableForFreeDisplay = usableMeterGeometry &&
    input.signsDatasetState === "fresh" &&
    isUsablePaidSchedule(input.paidHours) &&
    input.classification.status === "free" &&
    input.classification.coverage === "full" &&
    hasFreeReferenceEvidence &&
    hasOnlyFreeReferenceEvidence;
  const usableForReferenceDisplay = usableForPaidDisplay || usableForProhibitedDisplay || usableForFreeDisplay;

  if (!usableForReferenceDisplay) {
    return {
      usableForPaidDisplay: false,
      usableForProhibitedDisplay: false,
      usableForFreeDisplay: false,
      usableForReferenceDisplay: false,
      displayStatus: null,
      geometryBasis: "unvalidated",
      recommendationEligible: false,
      reason: "Meter blockface evidence did not satisfy the bounded paid-display policy.",
      evidence: null
    };
  }

  return {
    usableForPaidDisplay,
    usableForProhibitedDisplay,
    usableForFreeDisplay,
    usableForReferenceDisplay: true,
    displayStatus: usableForProhibitedDisplay ? "cannot_park" : usableForPaidDisplay ? "paid" : "free",
    geometryBasis: "official_meter_blockface",
    recommendationEligible: false,
    reason: usableForProhibitedDisplay
      ? "Fresh NYC sign evidence confirms a supported no-parking rule overlapping the requested interval on this official meter blockface."
      : usableForPaidDisplay
        ? "Official NYC DOT ParkNYC blockface data confirms a paid meter schedule for the full requested interval."
        : "Fresh linked NYC sign records and a recognized ParkNYC meter schedule resolve the full requested interval with no active payment or recognized prohibition.",
    evidence: {
      source: `nyc-dot-meter-blockfaces:${input.configuredDatasetId}`,
      reason: usableForFreeDisplay
        ? "Public-data free estimate on informational, side-specific meter blockface geometry. Verify every posted sign, hydrant clearance, curb condition, and the meter or ParkNYC app; this is not a claim of exact legal curb extent or physical availability."
        : "Informational, side-specific meter blockface geometry; verify posted signs and the meter or ParkNYC app. It does not establish exact legal curb extent or physical availability.",
      confidence: Math.min(0.85, Math.max(0.1, input.classification.confidence))
    }
  };
}

export const meterGeometryPolicyInternals = { isOnStreetMeterRate, isUsablePaidSchedule };
