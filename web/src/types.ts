import type { Feature, FeatureCollection, LineString, MultiLineString } from 'geojson'

export type Place = {
  properties: { label?: string; name?: string }
  geometry: { coordinates: [number, number] }
}

export type ParkingStatus = 'cannot_park' | 'paid' | 'free' | 'unknown'

export type ParkingMapProperties = {
  status: ParkingStatus
  color: string
  confidence: number
  coverage: 'full' | 'partial' | 'none'
  geometryValidated: boolean
  geometryBasis?: 'dot_approved_curb' | 'official_meter_blockface' | 'unvalidated'
  recommendationEligible?: boolean
  ruleSummary: string
  nextChange: string | null
  onStreet?: string | null
  fromStreet?: string | null
  toStreet?: string | null
  sideOfStreet?: string | null
}

export type ParkingProperties = ParkingMapProperties & {
  blockfaceKey: string
  evidence: Array<{ source: string; reason: string; confidence: number }>
  sourceVersion: string | null
  sourceUpdatedAt: string | null
  interpretationVersion: string
  changes: Array<{ at: string; status: ParkingStatus }>
  verifyPostedSigns: true
  paidHours?: string | null
  meterRate?: string | null
}

export type ParkingFeature = Feature<LineString | MultiLineString, ParkingProperties>
export type ParkingMapFeature = Feature<LineString | MultiLineString, ParkingMapProperties>
export type ParkingViewportFeature = ParkingFeature | ParkingMapFeature

export function isFullParkingFeature(feature: ParkingViewportFeature): feature is ParkingFeature {
  return 'evidence' in feature.properties && Array.isArray(feature.properties.evidence)
}

export type Garage = {
  id: string
  name: string
  legalName: string
  dbaName: string | null
  address: string
  latitude: number
  longitude: number
  phone?: string | null
  licenseNumber: string
  licenseStatus: 'Active'
  licenseExpiresAt: string | null
  facilityDetails: string | null
}

export type Mode = 'best' | 'street' | 'garage'
export type SheetSnap = 'minimized' | 'half' | 'expanded'

export type Recommendation = {
  id: string
  kind: 'curb' | 'licensed_facility' | 'park_and_ride'
  tier: 'free' | 'paid' | 'facility' | 'park_and_ride'
  status: 'free' | 'paid'
  title: string
  subtitle: string
  latitude: number
  longitude: number
  distanceMeters: number
  walkMinutes: number
  confidence: number | null
  coverage: 'full'
  score: number
  ruleSummary: string
  nextChange: string | null
  sourceVersion: string | null
  facility: null | {
    legalName: string
    dbaName: string | null
    licenseNumber: string
    licenseStatus: 'Active'
    licenseExpiresAt: string | null
    facilityDetails: string | null
  }
  transit: null | {
    state: 'live' | 'scheduled'
    realtimeAsOf: string | null
    legs: Array<Record<string, unknown>>
  }
  guidanceLevel?: 'approved_curb' | 'public_data_reference' | 'licensed_facility' | 'transit'
}

export type Availability = {
  cannotPark: number
  paid: number
  free: number
  unknown: number
}

export type ParkingPreferences = {
  allowPaid: boolean
  allowGarages: boolean
  maxWalkMinutes: number
  allowTransit: boolean
  accessibleOnly: boolean
  transitModes: Array<'SUBWAY' | 'BUS' | 'SIR' | 'LIRR' | 'METRO_NORTH'>
}

export type ParkingPlan = {
  place: Place
  origin: Place | null
  label: string
  originLabel: string
  arrivalInput: string
  departureInput: string
  arrivalIso: string
  departureIso: string
  preferences: ParkingPreferences
  recommendations: Recommendation[]
  availability: Availability
  preferredRadiusMeters?: number
  searchRadiusMeters?: number
  warnings: Array<{ code: string; message: string }>
  disclaimer: string
}

export type ViewportPayload = FeatureCollection<LineString | MultiLineString, ParkingMapProperties | ParkingProperties> & {
  returned: number
  clipped: boolean
  summary: Availability
  generatedAt: string
  interval: { start: string; end: string }
  advisory: true
}

export type RecommendationPayload = {
  generatedAt: string
  expiresAt: string
  interval: { start: string; end: string }
  timezone: string
  advisory: true
  preferences: {
    allowPaid: boolean
    allowGarages: boolean
    maxWalkMinutes: number
    allowTransit: boolean
    accessibleOnly: boolean
  }
  availability: Availability
  options: Recommendation[]
  preferredRadiusMeters?: number
  searchRadiusMeters?: number
  warnings: Array<{ code: string; message: string }>
  disclaimer: string
}
