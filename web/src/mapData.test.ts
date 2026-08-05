import { describe, expect, it } from 'vitest'
import type { ParkingFeature, ParkingPlan } from './types'
import { bestParkingFocus, indexParkingFeatures, parkingRenderGeoJSON, recommendationGeoJSON } from './mapData'

const feature: ParkingFeature = {
  type: 'Feature',
  id: 'segment-1',
  geometry: { type: 'LineString', coordinates: [[-73.98, 40.74], [-73.97, 40.75]] },
  properties: {
    blockfaceKey: 'M|5 AVENUE|W 33 STREET|W 34 STREET|East',
    status: 'paid',
    color: '#f2c14e',
    confidence: 0.95,
    coverage: 'full',
    geometryValidated: true,
    ruleSummary: 'Yellow means paid parking.',
    evidence: [{ source: 'meter', reason: 'Meter schedule applies.', confidence: 0.95 }],
    sourceVersion: 'snapshot-1',
    sourceUpdatedAt: '2026-07-19T04:00:00.000Z',
    interpretationVersion: 'rules-v2',
    changes: [{ at: '2026-07-19T20:00:00.000Z', status: 'free' }],
    nextChange: '2026-07-19T20:00:00.000Z',
    verifyPostedSigns: true,
    onStreet: '5 Avenue',
  },
}

describe('parking map render data', () => {
  it('sends only paint properties and geometry to the map worker', () => {
    const rendered = parkingRenderGeoJSON([feature])

    expect(rendered.features[0].id).toBe('segment-1')
    expect(rendered.features[0].properties).toEqual({ status: 'paid', color: '#f2c14e' })
    expect(rendered.features[0].properties).not.toHaveProperty('evidence')
    expect(indexParkingFeatures([feature]).get('segment-1')).toBe(feature)
  })

  it('uses a deterministic local id when an upstream feature id is absent', () => {
    const withoutId = { ...feature, id: undefined }
    const rendered = parkingRenderGeoJSON([withoutId])

    expect(rendered.features[0].id).toBe('curb-0')
    expect(indexParkingFeatures([withoutId]).get('curb-0')).toBe(withoutId)
  })

  it('marks recommendations by rank and focuses the highest-ranked parking lead', () => {
    const recommendation = {
      id: 'best-1', kind: 'curb' as const, tier: 'free' as const, status: 'free' as const,
      title: 'West 34 Street', subtitle: '5 Ave to 6 Ave', latitude: 40.748, longitude: -73.986,
      distanceMeters: 120, walkMinutes: 2, confidence: 0.9, coverage: 'full' as const,
      score: 9, ruleSummary: 'Free for the selected stay.', nextChange: null,
      sourceVersion: 'test', facility: null, transit: null,
    }
    const plan = {
      place: { properties: { label: 'Destination' }, geometry: { coordinates: [-73.98, 40.75] } },
      recommendations: [recommendation],
    } as Pick<ParkingPlan, 'place' | 'recommendations'>

    expect(bestParkingFocus(plan)).toEqual({
      center: [-73.986, 40.748], zoom: 18, recommendation,
    })
    expect(recommendationGeoJSON([recommendation]).features[0].properties?.rank).toBe(1)
  })

  it('falls back to the destination when no supported parking lead exists', () => {
    const plan = {
      place: { properties: { label: 'Destination' }, geometry: { coordinates: [-73.98, 40.75] } },
      recommendations: [],
    } as Pick<ParkingPlan, 'place' | 'recommendations'>

    expect(bestParkingFocus(plan)).toEqual({
      center: [-73.98, 40.75], zoom: 15.1, recommendation: null,
    })
  })
})
