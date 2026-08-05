import { describe, expect, it } from 'vitest'
import { buildCurbViewportRequest } from './curbViewport'

const base = {
  bounds: { south: 40.74, west: -74, north: 40.76, east: -73.97 },
  mapCenter: [-73.9857, 40.7484] as [number, number],
  destination: [-73.9857, 40.7484] as [number, number],
  zoom: 15.1,
  maxWalkMinutes: 10,
  start: '2026-07-19T18:00:00.000Z',
  end: '2026-07-19T20:00:00.000Z',
}

describe('curb viewport request', () => {
  it('keeps the destination parking area stable across zoom changes', () => {
    const first = buildCurbViewportRequest({ ...base, anchorToDestination: true })
    const zoomed = buildCurbViewportRequest({
      ...base,
      bounds: { south: 40.747, west: -73.988, north: 40.75, east: -73.983 },
      zoom: 18,
      anchorToDestination: true,
    })

    expect(first.radiusMeters).toBe(800)
    expect(zoomed.cacheKey).toBe(first.cacheKey)
    expect(zoomed.query).toBe(first.query)
  })

  it('uses the visible bounds and zoom after the user pans away', () => {
    const first = buildCurbViewportRequest({ ...base, anchorToDestination: false })
    const moved = buildCurbViewportRequest({
      ...base,
      bounds: { south: 40.72, west: -74.02, north: 40.74, east: -73.99 },
      mapCenter: [-74.005, 40.73],
      zoom: 16.5,
      anchorToDestination: false,
    })

    expect(moved.cacheKey).not.toBe(first.cacheKey)
    expect(new URLSearchParams(moved.query).get('zoom')).toBe('16.5')
    expect(new URLSearchParams(moved.query).get('detail')).toBe('map')
  })
})
