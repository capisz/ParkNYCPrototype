import { distanceMeters } from './mapData'

const MIN_RADIUS_METERS = 120
const MAX_RADIUS_METERS = 1_200
const WALKING_METERS_PER_MINUTE = 80

export type ViewportBounds = {
  south: number
  west: number
  north: number
  east: number
}

type BuildViewportRequest = {
  bounds: ViewportBounds
  mapCenter: [number, number]
  destination: [number, number]
  zoom: number
  anchorToDestination: boolean
  maxWalkMinutes: number
  start: string
  end: string
}

export type CurbViewportRequest = {
  cacheKey: string
  query: string
  center: [number, number]
  radiusMeters: number
}

function rounded(value: number, places: number): string {
  return value.toFixed(places)
}

/**
 * Produces a stable destination query until the user pans away. Zooming does not
 * change the planned parking area, so it must not download or reparse the same
 * curb records again.
 */
export function buildCurbViewportRequest(input: BuildViewportRequest): CurbViewportRequest {
  const center = input.anchorToDestination ? input.destination : input.mapCenter
  const horizontalRadius = Math.min(
    distanceMeters(center, [input.bounds.east, center[1]]),
    distanceMeters(center, [input.bounds.west, center[1]]),
  )
  const verticalRadius = Math.min(
    distanceMeters(center, [center[0], input.bounds.north]),
    distanceMeters(center, [center[0], input.bounds.south]),
  )
  const desiredWalkRadius = Math.min(
    MAX_RADIUS_METERS,
    Math.max(MIN_RADIUS_METERS, input.maxWalkMinutes * WALKING_METERS_PER_MINUTE),
  )
  const radiusMeters = Math.round(input.anchorToDestination
    ? desiredWalkRadius
    : Math.min(
      MAX_RADIUS_METERS,
      Math.max(MIN_RADIUS_METERS, Math.min(horizontalRadius, verticalRadius) * 0.92),
    ))

  const latitudeDelta = radiusMeters / 111_320
  const longitudeDelta = radiusMeters / (111_320 * Math.max(Math.cos(center[1] * Math.PI / 180), 0.2))
  const queryBounds = input.anchorToDestination ? {
    south: center[1] - latitudeDelta,
    west: center[0] - longitudeDelta,
    north: center[1] + latitudeDelta,
    east: center[0] + longitudeDelta,
  } : input.bounds
  const queryZoom = input.anchorToDestination ? 16 : input.zoom

  const query = new URLSearchParams({
    minLat: String(queryBounds.south),
    minLng: String(queryBounds.west),
    maxLat: String(queryBounds.north),
    maxLng: String(queryBounds.east),
    centerLat: String(center[1]),
    centerLng: String(center[0]),
    radiusMeters: String(radiusMeters),
    zoom: String(queryZoom),
    start: input.start,
    end: input.end,
    detail: 'map',
  }).toString()
  const viewportToken = input.anchorToDestination ? 'planned-area' : rounded(input.zoom, 1)
  const cacheKey = [
    'curbs', rounded(center[1], 4), rounded(center[0], 4), viewportToken,
    Math.round(radiusMeters / 25) * 25, input.start, input.end,
  ].join(':')

  return { cacheKey, query, center, radiusMeters }
}
