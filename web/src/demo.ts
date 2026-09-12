import type { ParkingFeature, Place, Recommendation } from './types'

import { DEMO_NOTICE } from './demoConfig'
const places: Place[] = [
  { properties: { label: 'Empire State Building, Manhattan' }, geometry: { coordinates: [-73.9857, 40.7484] } },
  { properties: { label: 'Bryant Park, Manhattan' }, geometry: { coordinates: [-73.9832, 40.7536] } },
  { properties: { label: 'Times Square, Manhattan' }, geometry: { coordinates: [-73.9855, 40.7580] } },
]
let center = places[0].geometry.coordinates
const statuses = ['cannot_park', 'paid', 'free', 'unknown'] as const
function curbs(): ParkingFeature[] {
  return statuses.map((status, index) => ({
    type: 'Feature', id: `demo-${index}`,
    geometry: { type: 'LineString', coordinates: [
      [center[0] + (index - 1.5) * 0.001, center[1] - 0.0006],
      [center[0] + (index - 1.5) * 0.001, center[1] + 0.0006],
    ] },
    properties: {
      blockfaceKey: `demo-${index}`, status, color: ['#d3232a', '#f2c14e', '#238b45', '#667085'][index],
      confidence: 0, coverage: status === 'unknown' ? 'none' : 'full', geometryValidated: false,
      onStreet: `Sample block ${index + 1}`, ruleSummary: `Fictional ${status.replace('_', ' ')} example. ${DEMO_NOTICE}.`,
      nextChange: null, evidence: [], sourceVersion: 'fictional-demo', sourceUpdatedAt: null,
      interpretationVersion: 'demo', changes: [], verifyPostedSigns: true,
    },
  }))
}

// This adapter is loaded only by an explicit demo build. Live requests never fall back to sample data.
export async function demoRequest(url: string, options: RequestInit = {}): Promise<unknown> {
  options.signal?.throwIfAborted()
  const parsed = new URL(url, 'https://demo.invalid')
  const now = new Date().toISOString()
  if (parsed.pathname.startsWith('/api/v1/search')) {
    const query = (parsed.searchParams.get('q') ?? parsed.searchParams.get('text') ?? '').toLowerCase()
    return { features: places.filter(place => place.properties.label!.toLowerCase().includes(query)) }
  }
  if (parsed.pathname === '/api/v1/plans') {
    const body = JSON.parse(String(options.body))
    center = [body.destination.longitude, body.destination.latitude]
    const preferences = { ...body.preferences, allowGarages: body.preferences.includeGarages, allowTransit: false }
    const optionsList: Recommendation[] = curbs().filter(feature => feature.properties.status === 'free' || (feature.properties.status === 'paid' && preferences.allowPaid)).map((feature, index) => ({
      id: String(feature.id), kind: 'curb', tier: feature.properties.status as 'free' | 'paid', status: feature.properties.status as 'free' | 'paid',
      title: feature.properties.onStreet!, subtitle: 'Fictional demo parking option', latitude: center[1],
      longitude: center[0] + (Number(String(feature.id).split('-')[1]) - 1.5) * 0.001,
      distanceMeters: 160, walkMinutes: 2, confidence: null, coverage: 'full', score: index,
      ruleSummary: feature.properties.ruleSummary, nextChange: null, sourceVersion: 'fictional-demo', facility: null, transit: null,
    }))
    return {
      generatedAt: now, expiresAt: new Date(Date.now() + 3600000).toISOString(), interval: { start: body.arriveBy, end: body.leaveAt },
      timezone: 'America/New_York', advisory: true, preferences,
      availability: { cannotPark: 1, paid: 1, free: 1, unknown: 1 },
      options: preferences.accessibleOnly || preferences.maxWalkMinutes < 2 ? [] : optionsList,
      warnings: [{ code: 'demo', message: DEMO_NOTICE }], disclaimer: DEMO_NOTICE,
    }
  }
  if (parsed.pathname === '/api/v1/curb/viewport') return {
    type: 'FeatureCollection', features: curbs(), returned: 4, clipped: false, advisory: true, generatedAt: now,
    interval: { start: parsed.searchParams.get('start'), end: parsed.searchParams.get('end') },
    summary: { cannotPark: 1, paid: 1, free: 1, unknown: 1 },
  }
  if (parsed.pathname.startsWith('/api/v1/curb/')) {
    const feature = curbs().find(item => item.id === decodeURIComponent(parsed.pathname.split('/').pop()!))
    if (!feature) throw new Error('Demo curb not found')
    return feature
  }
  if (parsed.pathname === '/api/v1/facilities') return { facilities: [] }
  if (parsed.pathname === '/api/v1/hydrants/viewport') return { type: 'FeatureCollection', features: [] }
  throw new Error(`Unsupported demo request: ${parsed.pathname}`)
}
