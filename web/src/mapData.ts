import type { FeatureCollection, LineString, MultiLineString, Point, Polygon } from 'geojson'
import type { Garage, ParkingPlan, ParkingViewportFeature, Recommendation } from './types'

export const emptyCollection: FeatureCollection = { type: 'FeatureCollection', features: [] }

type ParkingRenderProperties = {
  status: ParkingViewportFeature['properties']['status']
  color: string
}

export function parkingFeatureId(feature: ParkingViewportFeature, index = 0): string {
  return String(feature.id ?? `curb-${index}`)
}

/**
 * MapLibre clones GeoJSON into a worker. Keep the render source deliberately
 * small and retain evidence, schedules, and labels in React for detail views.
 */
export function parkingRenderGeoJSON(
  features: ParkingViewportFeature[],
): FeatureCollection<LineString | MultiLineString, ParkingRenderProperties> {
  return {
    type: 'FeatureCollection',
    features: features.map((feature, index) => ({
      type: 'Feature',
      id: parkingFeatureId(feature, index),
      geometry: feature.geometry,
      properties: {
        status: feature.properties.status,
        color: feature.properties.color,
      },
    })),
  }
}

export function indexParkingFeatures(features: ParkingViewportFeature[]): Map<string, ParkingViewportFeature> {
  return new Map(features.map((feature, index) => [parkingFeatureId(feature, index), feature]))
}

export function recommendationGeoJSON(options: Recommendation[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: options.map((option, index) => ({
      type: 'Feature',
      id: option.id,
      geometry: { type: 'Point', coordinates: [option.longitude, option.latitude] },
      properties: { id: option.id, tier: option.tier, title: option.title, rank: index + 1 },
    })),
  }
}

export type ParkingFocus = {
  center: [number, number]
  zoom: number
  recommendation: Recommendation | null
}

/** Rank 1 is the primary map target; the destination remains a context marker. */
export function bestParkingFocus(plan: Pick<ParkingPlan, 'place' | 'recommendations'>): ParkingFocus {
  const recommendation = plan.recommendations[0] ?? null
  return {
    center: recommendation
      ? [recommendation.longitude, recommendation.latitude]
      : plan.place.geometry.coordinates,
    zoom: recommendation ? 18 : 15.1,
    recommendation,
  }
}

export function garageGeoJSON(garages: Garage[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: garages.map(garage => ({
      type: 'Feature',
      id: garage.id,
      geometry: { type: 'Point', coordinates: [garage.longitude, garage.latitude] },
      properties: { id: garage.id, name: garage.name, address: garage.address },
    })),
  }
}

export function selectedCurbGeoJSON(feature: ParkingViewportFeature | null): FeatureCollection<LineString | MultiLineString> {
  return feature
    ? { type: 'FeatureCollection', features: [feature] }
    : { type: 'FeatureCollection', features: [] }
}

export function distanceMeters(a: [number, number], b: [number, number]): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180
  const latitude1 = toRadians(a[1])
  const latitude2 = toRadians(b[1])
  const deltaLatitude = latitude2 - latitude1
  const deltaLongitude = toRadians(b[0] - a[0])
  const value = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

export function proximityCircle(center: [number, number], radiusMeters: number): FeatureCollection<Polygon> {
  const points: [number, number][] = []
  const latitudeScale = 1 / 111320
  const longitudeScale = 1 / (111320 * Math.max(Math.cos(center[1] * Math.PI / 180), 0.2))
  for (let index = 0; index <= 64; index += 1) {
    const angle = index / 64 * Math.PI * 2
    points.push([
      center[0] + Math.cos(angle) * radiusMeters * longitudeScale,
      center[1] + Math.sin(angle) * radiusMeters * latitudeScale,
    ])
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [points] }, properties: {} }],
  }
}

export function curbMidpoint(feature: ParkingViewportFeature): [number, number] | null {
  const coordinates = feature.geometry.type === 'LineString'
    ? feature.geometry.coordinates
    : feature.geometry.coordinates.reduce((longest, line) => line.length > longest.length ? line : longest, [])
  if (!coordinates.length) return null
  return coordinates[Math.floor(coordinates.length / 2)] as [number, number]
}
