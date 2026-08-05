import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { Map as MapLibreMap, Marker } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import { fetchCurbDetail, fetchGarages, fetchHydrants, fetchParkingViewport } from '../api'
import { TimedLruCache } from '../cache'
import { buildCurbViewportRequest } from '../curbViewport'
import {
  bestParkingFocus,
  curbMidpoint,
  emptyCollection,
  garageGeoJSON,
  indexParkingFeatures,
  parkingRenderGeoJSON,
  proximityCircle,
  recommendationGeoJSON,
  selectedCurbGeoJSON,
} from '../mapData'
import { isFullParkingFeature } from '../types'
import type {
  Availability,
  Garage,
  Mode,
  ParkingFeature,
  ParkingPlan,
  ParkingViewportFeature,
  Recommendation,
  SheetSnap,
  ViewportPayload,
} from '../types'
import { DebouncedViewportRefresh } from '../viewportRefresh'
import AdaptiveMapSheet from './AdaptiveMapSheet'
import LoadingOverlay from './LoadingOverlay'

const CURB_MIN_ZOOM = 15
const HYDRANT_MIN_ZOOM = 18
const VIEWPORT_REFRESH_DELAY_MS = 320
const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/bright'

const viewportCache = new TimedLruCache<ViewportPayload>(24, 30_000)
const curbDetailCache = new TimedLruCache<ParkingFeature>(128, 5 * 60_000)
const garageCache = new TimedLruCache<Garage[]>(16, 3 * 60_000)
const hydrantCache = new TimedLruCache<FeatureCollection>(24, 5 * 60_000)

function applyModeVisibility(map: MapLibreMap, mode: Mode): void {
  const showStreets = mode === 'best' || mode === 'street'
  for (const layer of ['parking-casing', 'parking', 'parking-unknown', 'selected-curb-halo', 'selected-curb-line', 'proximity-fill', 'proximity-line', 'hydrant-exclusion-fill', 'hydrant-exclusion-ring']) {
    if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', showStreets ? 'visible' : 'none')
  }
  if (map.getLayer('hydrants')) map.setLayoutProperty('hydrants', 'visibility', showStreets ? 'visible' : 'none')
  if (map.getLayer('garages')) map.setLayoutProperty('garages', 'visibility', mode === 'garage' ? 'visible' : 'none')
  if (map.getLayer('recommendations')) map.setLayoutProperty('recommendations', 'visibility', mode === 'best' ? 'visible' : 'none')
}

type Props = {
  plan: ParkingPlan
  onChangePlan: () => void
}

type ViewportPrefetch = {
  cacheKey: string
  controller: AbortController
  request: Promise<ViewportPayload>
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function rounded(value: number, places: number): string {
  return value.toFixed(places)
}

function cacheAge(storedAt: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - storedAt) / 60_000))
  return `${minutes} min ago`
}

function mapPadding(snap: SheetSnap): maplibregl.PaddingOptions {
  const mobile = window.matchMedia('(max-width: 760px)').matches
  if (!mobile) return { top: 26, right: 78, bottom: 26, left: snap === 'minimized' ? 72 : 430 }
  const height = window.innerHeight
  const bottom = snap === 'minimized'
    ? 96
    : snap === 'half'
      ? Math.min(460, height * 0.52)
      : Math.min(height - 92, height * 0.8)
  return { top: 62, right: 18, bottom, left: 18 }
}

export default function ParkingMapScreen({ plan, onChangePlan }: Props) {
  const parkingFocus = useMemo(() => bestParkingFocus(plan), [plan])
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const modeRef = useRef<Mode>('best')
  const garagesRef = useRef<Garage[]>([])
  const parkingByIdRef = useRef(new Map<string, ParkingViewportFeature>())
  const parkingRenderKeyRef = useRef<string | null>(null)
  const selectedCurbIdRef = useRef<string | null>(null)
  const curbDetailAbortRef = useRef<AbortController | null>(null)
  const recommendationsRef = useRef(plan.recommendations)
  const loadViewportRef = useRef<() => Promise<void>>(async () => {})
  const requestAbortRef = useRef<AbortController | null>(null)
  const viewportPrefetchRef = useRef<ViewportPrefetch | null>(null)
  const initialLoadCompleteRef = useRef(false)
  const initialMovePendingRef = useRef(false)
  const refreshSchedulerRef = useRef<DebouncedViewportRefresh | null>(null)
  const userMovedMapRef = useRef(false)
  const [mode, setMode] = useState<Mode>('best')
  const [snap, setSnap] = useState<SheetSnap>('half')
  const [parking, setParking] = useState<ParkingViewportFeature[]>([])
  const [garages, setGarages] = useState<Garage[]>([])
  const [availability, setAvailability] = useState<Availability | null>(plan.availability)
  const [selectedCurb, setSelectedCurb] = useState<ParkingViewportFeature | null>(null)
  const [isCurbDetailLoading, setIsCurbDetailLoading] = useState(false)
  const [curbDetailError, setCurbDetailError] = useState<string | null>(null)
  const [selectedGarage, setSelectedGarage] = useState<Garage | null>(null)
  const [selectedRecommendation, setSelectedRecommendation] = useState<Recommendation | null>(parkingFocus.recommendation)
  const [message, setMessage] = useState('Loading nearby parking guidance…')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [now, setNow] = useState(Date.now())

  if (refreshSchedulerRef.current === null) {
    refreshSchedulerRef.current = new DebouncedViewportRefresh(
      () => void loadViewportRef.current(),
      () => requestAbortRef.current?.abort(),
      VIEWPORT_REFRESH_DELAY_MS,
    )
  }

  useEffect(() => {
    garagesRef.current = garages
  }, [garages])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const clearSelection = useCallback(() => {
    selectedCurbIdRef.current = null
    curbDetailAbortRef.current?.abort()
    setSelectedCurb(null)
    setIsCurbDetailLoading(false)
    setCurbDetailError(null)
    setSelectedGarage(null)
    setSelectedRecommendation(null)
    const source = mapRef.current?.getSource('selected-curb') as maplibregl.GeoJSONSource | undefined
    source?.setData(emptyCollection)
  }, [])

  const selectCurb = useCallback((feature: ParkingViewportFeature, focus = true) => {
    curbDetailAbortRef.current?.abort()
    const id = String(feature.id ?? '')
    selectedCurbIdRef.current = id
    setSelectedCurb(feature)
    setCurbDetailError(null)
    setSelectedGarage(null)
    setSelectedRecommendation(null)
    setSnap('half')
    const map = mapRef.current
    const source = map?.getSource('selected-curb') as maplibregl.GeoJSONSource | undefined
    source?.setData(selectedCurbGeoJSON(feature))
    const center = curbMidpoint(feature)
    if (focus && center) map?.flyTo({ center, zoom: 18, duration: 650 })
    if (isFullParkingFeature(feature) || !id) {
      setIsCurbDetailLoading(false)
      return
    }

    const cacheKey = `${id}:${plan.arrivalIso}:${plan.departureIso}`
    const cached = curbDetailCache.get(cacheKey)
    if (cached) {
      setSelectedCurb(cached.value)
      setIsCurbDetailLoading(false)
      source?.setData(selectedCurbGeoJSON(cached.value))
      return
    }

    const controller = new AbortController()
    curbDetailAbortRef.current = controller
    setIsCurbDetailLoading(true)
    void fetchCurbDetail(id, plan.arrivalIso, plan.departureIso, controller.signal).then(detail => {
      if (controller.signal.aborted || selectedCurbIdRef.current !== id) return
      // Keep the compact viewport's eligibility metadata when an older or
      // cached detail response does not yet carry the new reference fields.
      // Losing these fields after hydration could incorrectly remove the
      // prominent "reference only" warning from a selected meter blockface.
      const hydratedDetail: ParkingFeature = {
        ...detail,
        properties: {
          ...detail.properties,
          geometryBasis: detail.properties.geometryBasis ?? feature.properties.geometryBasis,
          recommendationEligible: detail.properties.recommendationEligible ?? feature.properties.recommendationEligible,
        },
      }
      curbDetailCache.set(cacheKey, hydratedDetail)
      setSelectedCurb(hydratedDetail)
      setIsCurbDetailLoading(false)
      const selectedSource = mapRef.current?.getSource('selected-curb') as maplibregl.GeoJSONSource | undefined
      selectedSource?.setData(selectedCurbGeoJSON(hydratedDetail))
    }).catch(requestError => {
      if (controller.signal.aborted || aborted(requestError) || selectedCurbIdRef.current !== id) return
      setIsCurbDetailLoading(false)
      setCurbDetailError('Full rule evidence could not be loaded. The map classification remains visible; try selecting this curb again.')
    })
  }, [plan.arrivalIso, plan.departureIso])

  const selectGarage = useCallback((garage: Garage, focus = true) => {
    clearSelection()
    setSelectedGarage(garage)
    setSnap('half')
    if (focus) mapRef.current?.flyTo({ center: [garage.longitude, garage.latitude], zoom: 18, duration: 650 })
  }, [clearSelection])

  const selectRecommendation = useCallback((option: Recommendation, focus = true) => {
    clearSelection()
    setSelectedRecommendation(option)
    setSnap('half')
    if (focus) mapRef.current?.flyTo({ center: [option.longitude, option.latitude], zoom: 18, duration: 650 })
  }, [clearSelection])

  const loadViewport = useCallback(async () => {
    const map = mapRef.current
    if (!map?.getSource('parking')) return
    refreshSchedulerRef.current?.clearPending()
    requestAbortRef.current?.abort()
    const controller = new AbortController()
    requestAbortRef.current = controller
    const bounds = map.getBounds()
    const zoom = map.getZoom()
    const parkingSource = map.getSource('parking') as maplibregl.GeoJSONSource
    const hydrantSource = map.getSource('hydrants-data') as maplibregl.GeoJSONSource
    const proximitySource = map.getSource('proximity') as maplibregl.GeoJSONSource
    const initialRequest = !initialLoadCompleteRef.current
    const isCurrentRequest = () => requestAbortRef.current === controller && !controller.signal.aborted
    const finishPrimaryLoad = () => {
      if (!isCurrentRequest()) return
      const refreshAfterInitialLoad = !initialLoadCompleteRef.current && initialMovePendingRef.current
      initialLoadCompleteRef.current = true
      initialMovePendingRef.current = false
      setIsLoading(false)
      setIsRefreshing(false)
      if (refreshAfterInitialLoad) refreshSchedulerRef.current?.schedule()
    }
    const clearParking = () => {
      if (parkingRenderKeyRef.current !== null) {
        parkingSource.setData(emptyCollection)
        setParking([])
      }
      parkingRenderKeyRef.current = null
      parkingByIdRef.current.clear()
    }
    if (initialRequest) setIsLoading(true)
    else setIsRefreshing(true)
    setError(null)

    if (modeRef.current === 'garage') {
      clearParking()
      hydrantSource.setData(emptyCollection)
      proximitySource.setData(emptyCollection)
      const center = map.getCenter()
      const query = new URLSearchParams({ lat: rounded(center.lat, 5), lng: rounded(center.lng, 5), radius: '1800' }).toString()
      const cacheKey = `garages:${query}`
      const cached = garageCache.get(cacheKey)
      if (cached) {
        setGarages(cached.value)
        ;(map.getSource('garages') as maplibregl.GeoJSONSource).setData(garageGeoJSON(cached.value))
        setLastUpdated(new Date(cached.storedAt))
        setMessage(`${cached.value.length} licensed facilities near the map center`)
        finishPrimaryLoad()
        return
      }
      try {
        const facilities = await fetchGarages(query, controller.signal)
        if (!isCurrentRequest()) return
        const stored = garageCache.set(cacheKey, facilities)
        setGarages(facilities)
        ;(map.getSource('garages') as maplibregl.GeoJSONSource).setData(garageGeoJSON(facilities))
        setLastUpdated(new Date(stored.storedAt))
        setMessage(`${facilities.length} licensed facilities near the map center`)
      } catch (requestError) {
        if (!isCurrentRequest() || aborted(requestError)) return
        const stale = garageCache.get(cacheKey, true)
        if (stale) {
          setGarages(stale.value)
          ;(map.getSource('garages') as maplibregl.GeoJSONSource).setData(garageGeoJSON(stale.value))
          setError(`Facility refresh failed. Showing cached records from ${cacheAge(stale.storedAt)}.`)
        } else {
          setGarages([])
          ;(map.getSource('garages') as maplibregl.GeoJSONSource).setData(emptyCollection)
          setError('Current licensed-facility records are unavailable. No preview data was substituted.')
        }
        setMessage('Licensed-facility data needs a connection')
      } finally {
        finishPrimaryLoad()
      }
      return
    }

    if (zoom < CURB_MIN_ZOOM) {
      clearParking()
      hydrantSource.setData(emptyCollection)
      proximitySource.setData(emptyCollection)
      setAvailability(modeRef.current === 'best' ? plan.availability : null)
      setMessage('Zoom in to street level to load nearby curb guidance')
      finishPrimaryLoad()
      return
    }

    const mapCenter = map.getCenter()
    const anchorToDestination = !userMovedMapRef.current
    const viewportRequest = buildCurbViewportRequest({
      bounds: {
        south: bounds.getSouth(), west: bounds.getWest(),
        north: bounds.getNorth(), east: bounds.getEast(),
      },
      mapCenter: [mapCenter.lng, mapCenter.lat],
      destination: parkingFocus.center,
      zoom,
      anchorToDestination,
      maxWalkMinutes: plan.preferences.maxWalkMinutes,
      start: plan.arrivalIso,
      end: plan.departureIso,
    })
    const { cacheKey, center: centerCoordinates, query, radiusMeters } = viewportRequest
    proximitySource.setData(proximityCircle(centerCoordinates, radiusMeters))
    const displayCurbPayload = (payload: ViewportPayload, storedAt: number) => {
      if (parkingRenderKeyRef.current !== cacheKey) {
        const features = payload.features as ParkingViewportFeature[]
        parkingByIdRef.current = indexParkingFeatures(features)
        parkingSource.setData(parkingRenderGeoJSON(features))
        parkingRenderKeyRef.current = cacheKey
        setParking(features)
      }
      setAvailability(modeRef.current === 'best' ? plan.availability : payload.summary)
      setLastUpdated(new Date(storedAt))
      setMessage(modeRef.current === 'best'
        ? 'Visible curb map updated'
        : `${payload.summary.cannotPark} cannot park • ${payload.summary.paid} paid • ${payload.summary.free} likely free • ${payload.summary.unknown} unknown`)
    }
    const cached = viewportCache.get(cacheKey)
    if (cached) {
      displayCurbPayload(cached.value, cached.storedAt)
      finishPrimaryLoad()
    } else {
      try {
        const prefetched = viewportPrefetchRef.current?.cacheKey === cacheKey
          ? viewportPrefetchRef.current
          : null
        const payload = prefetched
          ? await prefetched.request
          : await fetchParkingViewport(query, controller.signal)
        if (!isCurrentRequest()) return
        if (prefetched && viewportPrefetchRef.current === prefetched) viewportPrefetchRef.current = null
        const stored = viewportCache.set(cacheKey, payload)
        displayCurbPayload(payload, stored.storedAt)
      } catch (requestError) {
        if (!isCurrentRequest() || aborted(requestError)) return
        const stale = viewportCache.get(cacheKey, true)
        if (stale) {
          displayCurbPayload(stale.value, stale.storedAt)
          setError(`Curb refresh failed. Showing cached classifications from ${cacheAge(stale.storedAt)}.`)
        } else {
          clearParking()
          setAvailability(modeRef.current === 'best' ? plan.availability : null)
          setError('Current curb guidance is unavailable. No preview streets were substituted.')
        }
        setMessage('Current parking data needs a connection')
      } finally {
        finishPrimaryLoad()
      }
    }

    if (zoom < HYDRANT_MIN_ZOOM || controller.signal.aborted) {
      hydrantSource.setData(emptyCollection)
      return
    }
    const hydrantQuery = new URLSearchParams({
      minLat: String(bounds.getSouth()), minLng: String(bounds.getWest()),
      maxLat: String(bounds.getNorth()), maxLng: String(bounds.getEast()),
    }).toString()
    const hydrantKey = `hydrants:${rounded(centerCoordinates[1], 4)}:${rounded(centerCoordinates[0], 4)}:${rounded(zoom, 1)}`
    const cachedHydrants = hydrantCache.get(hydrantKey)
    if (cachedHydrants) {
      hydrantSource.setData(cachedHydrants.value)
      return
    }
    try {
      const payload = await fetchHydrants(hydrantQuery, controller.signal)
      if (!isCurrentRequest()) return
      hydrantCache.set(hydrantKey, payload)
      hydrantSource.setData(payload)
    } catch (requestError) {
      if (!isCurrentRequest() || aborted(requestError)) return
      const stale = hydrantCache.get(hydrantKey, true)
      if (stale) hydrantSource.setData(stale.value)
      else hydrantSource.setData(emptyCollection)
    }
  }, [parkingFocus.center, plan.arrivalIso, plan.departureIso, plan.availability, plan.preferences.maxWalkMinutes])

  useEffect(() => {
    loadViewportRef.current = loadViewport
  }, [loadViewport])

  useEffect(() => {
    if (!container.current || mapRef.current) return
    const destination = plan.place.geometry.coordinates
    const map = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE_URL,
      center: parkingFocus.center,
      zoom: parkingFocus.zoom,
      minZoom: 11.5,
      maxZoom: 20,
      maxBounds: [[-74.32, 40.45], [-73.65, 40.95]],
    })
    mapRef.current = map
    const initialBounds = map.getBounds()
    const initialViewportRequest = buildCurbViewportRequest({
      bounds: {
        south: initialBounds.getSouth(), west: initialBounds.getWest(),
        north: initialBounds.getNorth(), east: initialBounds.getEast(),
      },
      mapCenter: parkingFocus.center,
      destination: parkingFocus.center,
      zoom: parkingFocus.zoom,
      anchorToDestination: true,
      maxWalkMinutes: plan.preferences.maxWalkMinutes,
      start: plan.arrivalIso,
      end: plan.departureIso,
    })
    if (!viewportCache.get(initialViewportRequest.cacheKey)) {
      const prefetchController = new AbortController()
      const request = fetchParkingViewport(initialViewportRequest.query, prefetchController.signal)
      viewportPrefetchRef.current = {
        cacheKey: initialViewportRequest.cacheKey,
        controller: prefetchController,
        request,
      }
      // A basemap failure can prevent initializeMap from awaiting this request.
      // Attach a handler now so the speculative request can never be unhandled.
      void request.catch(() => undefined)
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('error', () => {
      if (map.getSource('parking')) return
      setError('The basemap could not be loaded. Check your connection and retry.')
      setMessage('Map data needs a connection')
      setIsLoading(false)
    })
    map.on('styleimagemissing', event => {
      if (!map.hasImage(event.id)) map.addImage(event.id, { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) })
    })

    const markerElement = document.createElement('div')
    markerElement.className = 'destination-marker'
    markerElement.setAttribute('aria-label', `Destination: ${plan.label}`)
    markerElement.innerHTML = '<span></span>'
    const destinationMarker = new Marker({ element: markerElement, anchor: 'bottom' }).setLngLat(destination).addTo(map)

    let bestMarker: Marker | null = null
    if (parkingFocus.recommendation) {
      const best = parkingFocus.recommendation
      const bestMarkerElement = document.createElement('button')
      bestMarkerElement.type = 'button'
      bestMarkerElement.className = `best-parking-marker ${best.tier}`
      bestMarkerElement.setAttribute('aria-label', `Best parking lead: ${best.title}. ${best.walkMinutes} minute walk.`)
      bestMarkerElement.innerHTML = '<span class="best-parking-pulse"></span><span class="best-parking-dot"></span><b>BEST</b>'
      bestMarkerElement.addEventListener('click', event => {
        event.stopPropagation()
        selectRecommendation(best)
      })
      bestMarker = new Marker({ element: bestMarkerElement, anchor: 'center' })
        .setLngLat([best.longitude, best.latitude])
        .addTo(map)
    }

    const initializeMap = () => {
      map.addSource('parking', { type: 'geojson', data: emptyCollection })
      map.addSource('selected-curb', { type: 'geojson', data: emptyCollection })
      map.addSource('hydrants-data', { type: 'geojson', data: emptyCollection })
      map.addSource('garages', { type: 'geojson', data: emptyCollection })
      map.addSource('recommendations', { type: 'geojson', data: recommendationGeoJSON(recommendationsRef.current) })
      map.addSource('proximity', { type: 'geojson', data: emptyCollection })
      map.addLayer({ id: 'proximity-fill', type: 'fill', source: 'proximity', minzoom: CURB_MIN_ZOOM, paint: { 'fill-color': '#b6d8f6', 'fill-opacity': 0.07 } })
      map.addLayer({ id: 'proximity-line', type: 'line', source: 'proximity', minzoom: CURB_MIN_ZOOM, paint: { 'line-color': '#4e6ca8', 'line-width': 1.5, 'line-opacity': 0.55, 'line-dasharray': [2, 2] } })
      map.addLayer({
        id: 'parking-casing', type: 'line', source: 'parking', minzoom: CURB_MIN_ZOOM,
        filter: ['!=', ['get', 'status'], 'unknown'],
        paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 16, 8, 20, 14], 'line-opacity': 0.94 },
      })
      map.addLayer({
        id: 'parking', type: 'line', source: 'parking', minzoom: CURB_MIN_ZOOM,
        filter: ['!=', ['get', 'status'], 'unknown'],
        paint: { 'line-color': ['coalesce', ['get', 'color'], '#747b8d'], 'line-width': ['interpolate', ['linear'], ['zoom'], 16, 5.5, 20, 10], 'line-opacity': 0.98 },
      })
      map.addLayer({
        id: 'parking-unknown', type: 'line', source: 'parking', minzoom: 17,
        filter: ['==', ['get', 'status'], 'unknown'],
        paint: {
          'line-color': '#667085',
          'line-width': ['interpolate', ['linear'], ['zoom'], 17, 1.75, 20, 3.5],
          'line-opacity': 0.72,
          'line-dasharray': [1.2, 1.6],
        },
      })
      map.addLayer({ id: 'selected-curb-halo', type: 'line', source: 'selected-curb', minzoom: CURB_MIN_ZOOM, paint: { 'line-color': '#26324b', 'line-width': 17, 'line-opacity': 0.42 } })
      map.addLayer({ id: 'selected-curb-line', type: 'line', source: 'selected-curb', minzoom: CURB_MIN_ZOOM, paint: { 'line-color': ['coalesce', ['get', 'color'], '#4e6ca8'], 'line-width': 10, 'line-opacity': 1 } })
      map.addLayer({
        id: 'hydrant-exclusion-fill', type: 'fill', source: 'hydrants-data', minzoom: HYDRANT_MIN_ZOOM,
        filter: ['==', ['get', 'kind'], 'hydrant_exclusion'],
        paint: { 'fill-color': '#d3232a', 'fill-opacity': 0.18 },
      })
      map.addLayer({
        id: 'hydrant-exclusion-ring', type: 'line', source: 'hydrants-data', minzoom: HYDRANT_MIN_ZOOM,
        filter: ['==', ['get', 'kind'], 'hydrant_exclusion'],
        paint: { 'line-color': '#d3232a', 'line-width': 3.5, 'line-opacity': 1 },
      })
      map.addLayer({ id: 'garages', type: 'circle', source: 'garages', layout: { visibility: 'none' }, paint: { 'circle-radius': 10, 'circle-color': '#394b6a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } })
      map.addLayer({
        id: 'recommendations', type: 'circle', source: 'recommendations',
        paint: {
          'circle-radius': 10,
          'circle-color': ['match', ['get', 'tier'], 'free', '#238b45', 'paid', '#f2c14e', 'facility', '#61718f', '#225f9b'],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3,
        },
      })

      const hydrantImage = new Image()
      hydrantImage.onload = () => {
        if (!mapRef.current || map.hasImage('hydrant-icon')) return
        map.addImage('hydrant-icon', hydrantImage)
        map.addLayer({
          id: 'hydrants', type: 'symbol', source: 'hydrants-data', minzoom: HYDRANT_MIN_ZOOM,
          filter: ['==', ['get', 'kind'], 'hydrant'],
          layout: {
            'icon-image': 'hydrant-icon',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 18, 0.14, 20, 0.25],
            'icon-allow-overlap': true,
          },
        })
        applyModeVisibility(map, modeRef.current)
      }
      hydrantImage.src = '/hydrant.png'

      applyModeVisibility(map, modeRef.current)

      map.on('click', 'parking', event => {
        const id = String(event.features?.[0]?.id ?? '')
        const feature = parkingByIdRef.current.get(id)
        if (feature) selectCurb(feature, false)
      })
      map.on('click', 'parking-unknown', event => {
        const id = String(event.features?.[0]?.id ?? '')
        const feature = parkingByIdRef.current.get(id)
        if (feature) selectCurb(feature, false)
      })
      map.on('click', 'garages', event => {
        const id = String(event.features?.[0]?.properties?.id ?? event.features?.[0]?.id ?? '')
        const garage = garagesRef.current.find(item => item.id === id)
        if (garage) selectGarage(garage, false)
      })
      map.on('click', 'recommendations', event => {
        const id = String(event.features?.[0]?.properties?.id ?? event.features?.[0]?.id ?? '')
        const option = recommendationsRef.current.find(item => item.id === id)
        if (option) selectRecommendation(option, false)
      })
      map.on('click', event => {
        const layers = ['parking', 'parking-unknown', 'garages', 'recommendations'].filter(layer => map.getLayer(layer))
        if (map.queryRenderedFeatures(event.point, { layers }).length === 0) {
          clearSelection()
          setSnap('minimized')
        }
      })
      for (const layer of ['parking', 'parking-unknown', 'garages', 'recommendations']) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' })
      }
      void loadViewportRef.current()
    }

    map.on('load', initializeMap)
    map.on('moveend', () => {
      if (!initialLoadCompleteRef.current) {
        initialMovePendingRef.current = true
        return
      }
      refreshSchedulerRef.current?.schedule()
    })
    map.on('dragstart', () => {
      userMovedMapRef.current = true
      setSnap('minimized')
    })
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container.current)

    return () => {
      refreshSchedulerRef.current?.cancel()
      viewportPrefetchRef.current?.controller.abort()
      viewportPrefetchRef.current = null
      curbDetailAbortRef.current?.abort()
      observer.disconnect()
      destinationMarker.remove()
      bestMarker?.remove()
      map.remove()
      mapRef.current = null
    }
  }, [clearSelection, parkingFocus, plan.arrivalIso, plan.departureIso, plan.label, plan.place.geometry.coordinates, plan.preferences.maxWalkMinutes, selectCurb, selectGarage, selectRecommendation])

  useEffect(() => {
    const modeChanged = modeRef.current !== mode
    modeRef.current = mode
    if (modeChanged) clearSelection()
    const map = mapRef.current
    setAvailability(mode === 'best' ? plan.availability : null)
    if (!map?.getLayer('parking')) return
    applyModeVisibility(map, mode)
    void loadViewportRef.current()
  }, [clearSelection, mode, plan.availability])

  useEffect(() => {
    const apply = () => {
      const map = mapRef.current
      if (!map) return
      map.resize()
      map.easeTo({ padding: mapPadding(snap), duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240 })
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [snap])

  useEffect(() => {
    const online = () => {
      setIsOnline(true)
      void loadViewportRef.current()
    }
    const offline = () => {
      setIsOnline(false)
      setError('You are offline. Existing map data may be outdated.')
      setMessage('Current parking guidance requires a connection')
    }
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [])

  const recenter = useCallback(() => {
    userMovedMapRef.current = false
    if (parkingFocus.recommendation) selectRecommendation(parkingFocus.recommendation, false)
    mapRef.current?.flyTo({
      center: parkingFocus.center,
      zoom: parkingFocus.zoom,
      bearing: 0,
      pitch: 0,
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700,
    })
  }, [parkingFocus, selectRecommendation])

  const changeMode = (value: Mode) => {
    setMode(value)
    setSnap('half')
  }

  const retry = useCallback(() => {
    const map = mapRef.current
    if (map && !map.getSource('parking')) {
      setError(null)
      setIsLoading(true)
      map.setStyle(MAP_STYLE_URL)
      return
    }
    void loadViewportRef.current()
  }, [])

  const mapLabel = useMemo(() => parkingFocus.recommendation
    ? `Parking map centered on the best parking lead near ${plan.label}`
    : `Parking map centered near ${plan.label}`, [parkingFocus.recommendation, plan.label])

  const loadingTitle = mode === 'garage' ? 'Checking licensed facilities' : 'Loading nearby curb guidance'
  const loadingDetail = mode === 'garage'
    ? 'Verifying active NYC DCWP facility records near the visible map area.'
    : 'Checking geometry, rule coverage, and source freshness for your complete stay.'

  return <main className="app-shell" aria-busy={isLoading}>
    <div
      ref={container}
      className="map"
      role="region"
      aria-label={mapLabel}
      aria-describedby="map-hydrant-guidance"
    />
    <p id="map-hydrant-guidance" className="visually-hidden">
      At close zoom, red outlined areas show approximate fifteen-foot safety references around official hydrant points. They are not linked to validated curb geometry; verify the physical hydrant and curb.
    </p>
    <div className="map-action-stack">
      <button type="button" onClick={recenter} aria-label={parkingFocus.recommendation ? 'Center map on best parking lead' : 'Center map on planned destination'} title={parkingFocus.recommendation ? 'Center best parking lead' : 'Center destination'}>⌖</button>
    </div>
    <AdaptiveMapSheet
      plan={plan}
      mode={mode}
      snap={snap}
      availability={availability}
      parking={parking}
      garages={garages}
      selectedCurb={selectedCurb}
      isCurbDetailLoading={isCurbDetailLoading}
      curbDetailError={curbDetailError}
      selectedGarage={selectedGarage}
      selectedRecommendation={selectedRecommendation}
      message={message}
      error={error}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      isOnline={isOnline}
      lastUpdated={lastUpdated}
      now={now}
      onModeChange={changeMode}
      onSnapChange={setSnap}
      onChangePlan={onChangePlan}
      onRecenter={recenter}
      onRetry={retry}
      onClearSelection={clearSelection}
      onSelectCurb={selectCurb}
      onSelectGarage={selectGarage}
      onSelectRecommendation={selectRecommendation}
    />
    {isLoading && <LoadingOverlay title={loadingTitle} detail={loadingDetail} delayMs={180} />}
  </main>
}
