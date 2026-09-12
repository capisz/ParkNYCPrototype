import type { FeatureCollection } from 'geojson'
import type {
  Garage,
  ParkingFeature,
  ParkingPreferences,
  Place,
  RecommendationPayload,
  ViewportPayload,
} from './types'

export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options)
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const payload = await response.json() as { error?: string; message?: string }
      if (payload.message) message = payload.message
      else if (payload.error) message = payload.error
    } catch {
      // Keep the status-based message when the server did not return JSON.
    }
    throw new ApiError(message, response.status)
  }
  return response.json() as Promise<T>
}

function localInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function defaultArrivalInput(now = new Date()): string {
  const value = new Date(now.getTime() + 15 * 60 * 1_000)
  value.setMinutes(Math.ceil(value.getMinutes() / 15) * 15, 0, 0)
  return localInput(value)
}

export function defaultDepartureInput(arrivalInput: string): string {
  const arrival = new Date(arrivalInput)
  const value = Number.isFinite(arrival.getTime()) ? new Date(arrival.getTime() + 2 * 60 * 60 * 1_000) : new Date(Date.now() + 2 * 60 * 60 * 1_000)
  return localInput(value)
}

export function planningInterval(arrivalInput: string, departureInput: string, now = new Date()): { start: string; end: string } {
  if (!arrivalInput.trim()) throw new Error('Choose when you will arrive.')
  if (!departureInput.trim()) throw new Error('Choose when you will leave.')
  const arrival = new Date(arrivalInput)
  const departure = new Date(departureInput)
  if (!Number.isFinite(arrival.getTime()) || !Number.isFinite(departure.getTime())) throw new Error('Choose valid arrival and leave times.')
  if (arrival.getTime() < now.getTime() - 60 * 60 * 1_000) throw new Error('Arrival cannot be more than one hour in the past.')
  if (arrival.getTime() > now.getTime() + 30 * 24 * 60 * 60 * 1_000) throw new Error('Arrival must be within the next 30 days.')
  if (departure <= arrival) throw new Error('Leave time must be after arrival time.')
  if (departure.getTime() - arrival.getTime() > 7 * 24 * 60 * 60 * 1_000) throw new Error('Trips cannot exceed seven days.')
  return { start: arrival.toISOString(), end: departure.toISOString() }
}

export async function autocompleteDestination(query: string, signal?: AbortSignal): Promise<Place[]> {
  const payload = await requestJson<{ features?: Place[] }>(`/api/v1/search/autocomplete?q=${encodeURIComponent(query)}`, { signal })
  return payload.features ?? []
}

export async function searchDestination(query: string, signal?: AbortSignal): Promise<Place | null> {
  const payload = await requestJson<{ features?: Place[] }>(`/api/v1/search?text=${encodeURIComponent(query)}`, { signal })
  return payload.features?.[0] ?? null
}

export async function fetchPlan(
  destination: Place,
  origin: Place | null,
  interval: { start: string; end: string },
  preferences: ParkingPreferences,
  signal?: AbortSignal,
): Promise<RecommendationPayload> {
  const [longitude, latitude] = destination.geometry.coordinates
  const originCoordinates = origin?.geometry.coordinates
  return requestJson<RecommendationPayload>('/api/v1/plans', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      destination: { latitude, longitude, label: destination.properties.label ?? destination.properties.name },
      origin: originCoordinates ? {
        latitude: originCoordinates[1], longitude: originCoordinates[0],
        label: origin.properties.label ?? origin.properties.name,
      } : null,
      arriveBy: interval.start,
      leaveAt: interval.end,
      preferences: {
        allowPaid: preferences.allowPaid,
        includeGarages: preferences.allowGarages,
        maxWalkMinutes: preferences.maxWalkMinutes,
        transit: preferences.allowTransit,
        accessibleOnly: preferences.accessibleOnly,
        transitModes: preferences.transitModes,
      },
    }),
  })
}

export function fetchParkingViewport(query: string, signal?: AbortSignal): Promise<ViewportPayload> {
  return requestJson<ViewportPayload>(`/api/v1/curb/viewport?${query}`, { signal })
}

export function fetchCurbDetail(segmentId: string, start: string, end: string, signal?: AbortSignal): Promise<ParkingFeature> {
  const query = new URLSearchParams({ start, end }).toString()
  return requestJson<ParkingFeature>(`/api/v1/curb/${encodeURIComponent(segmentId)}?${query}`, { signal })
}

export async function fetchGarages(query: string, signal?: AbortSignal): Promise<Garage[]> {
  const payload = await requestJson<{ facilities?: Garage[] }>(`/api/v1/facilities?${query}`, { signal })
  return payload.facilities ?? []
}

export function fetchHydrants(query: string, signal?: AbortSignal): Promise<FeatureCollection> {
  return requestJson<FeatureCollection>(`/api/v1/hydrants/viewport?${query}`, { signal })
}
