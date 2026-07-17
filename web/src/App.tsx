import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'
import { countdown } from './countdown'

type Place = { properties: { label?: string; name?: string }; geometry: { coordinates: [number, number] } }
type ParkingProperties = { status: string; color: string; ruleSummary?: string; reason?: string; confidence: number; nextChange?: string; onStreet?: string; fromStreet?: string; toStreet?: string; sourceFreshness?: string }
type ParkingFeature = Feature<LineString, ParkingProperties>
type Garage = { id: string; name: string; address: string; latitude: number; longitude: number; phone?: string | null }
type Mode = 'street' | 'garage'

const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }
const demoCenter: [number, number] = [-73.9855, 40.7484]
const CURB_MIN_ZOOM = 16
const HYDRANT_MIN_ZOOM = 19
const MIN_PROXIMITY_RADIUS_METERS = 120
const MAX_PROXIMITY_RADIUS_METERS = 1200

function distanceMeters(a: [number, number], b: [number, number]): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180
  const latitude1 = toRadians(a[1])
  const latitude2 = toRadians(b[1])
  const deltaLatitude = latitude2 - latitude1
  const deltaLongitude = toRadians(b[0] - a[0])
  const value = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

function proximityCircle(center: [number, number], radiusMeters: number): FeatureCollection<Polygon> {
  const points: [number, number][] = []
  const latitudeScale = 1 / 111320
  const longitudeScale = 1 / (111320 * Math.cos(center[1] * Math.PI / 180))
  for (let index = 0; index <= 64; index += 1) {
    const angle = index / 64 * Math.PI * 2
    points.push([
      center[0] + Math.cos(angle) * radiusMeters * longitudeScale,
      center[1] + Math.sin(angle) * radiusMeters * latitudeScale
    ])
  }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [points] }, properties: {} }] }
}

function demoParking(): FeatureCollection<LineString, ParkingProperties> {
  const change = new Date(Date.now() + 38 * 60 * 1000).toISOString()
  const make = (id: string, status: string, color: string, street: string, coordinates: [number, number][], summary: string, confidence: number, nextChange?: string): ParkingFeature => ({
    type: 'Feature', id, geometry: { type: 'LineString', coordinates },
    properties: { status, color, onStreet: street, ruleSummary: summary, confidence, nextChange }
  })
  return { type: 'FeatureCollection', features: [
    make('demo-free', 'free', '#2EAD63', 'West 33rd Street', [[-73.9892, 40.7480], [-73.9855, 40.7495]], 'Demo: free parking is explicitly permitted during this window.', .91),
    make('demo-paid', 'paid', '#E6B422', '5th Avenue', [[-73.9869, 40.7465], [-73.9838, 40.7508]], 'Demo: metered parking is active until the displayed change time.', .88, change),
    make('demo-no', 'no_parking', '#D64545', 'West 34th Street', [[-73.9888, 40.7492], [-73.9840, 40.7512]], 'Demo: no standing is active at this curb.', .94),
    make('demo-unknown', 'unknown', '#8D93A6', 'Broadway', [[-73.9900, 40.7468], [-73.9866, 40.7513]], 'Demo: evidence is incomplete, so Pidge does not infer that parking is allowed.', .24)
  ] }
}

const demoGarages: Garage[] = [
  { id: 'demo-g1', name: 'Herald Square Garage', address: 'Demo facility near West 33rd Street', latitude: 40.7490, longitude: -73.9881 },
  { id: 'demo-g2', name: 'Fifth Avenue Parking', address: 'Demo facility near East 35th Street', latitude: 40.7501, longitude: -73.9834 }
]

function garageGeoJSON(garages: Garage[]): FeatureCollection<Point> {
  return { type: 'FeatureCollection', features: garages.map(garage => ({
    type: 'Feature', id: garage.id, geometry: { type: 'Point', coordinates: [garage.longitude, garage.latitude] },
    properties: { name: garage.name, address: garage.address }
  })) }
}

export default function App() {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const modeRef = useRef<Mode>('street')
  const selectedQueryRef = useRef('')
  const viewportAbortRef = useRef<AbortController | null>(null)
  const [entered, setEntered] = useState(false)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Place[]>([])
  const [parking, setParking] = useState<ParkingFeature[]>([])
  const [garages, setGarages] = useState<Garage[]>([])
  const [selected, setSelected] = useState<ParkingFeature | null>(null)
  const [mode, setMode] = useState<Mode>('street')
  const [showList, setShowList] = useState(true)
  const [isDemo, setIsDemo] = useState(false)
  const [message, setMessage] = useState('Move the map to load visible parking guidance.')
  const [now, setNow] = useState(Date.now())

  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])

  const displayItems = useMemo(() => parking.slice(0, 12), [parking])

  const showDemo = useCallback(() => {
    const map = mapRef.current
    const data = demoParking()
    const hydrants: FeatureCollection = { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-73.98525, 40.74945] }, properties: { kind: 'hydrant' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-73.98555, 40.74933], [-73.98495, 40.74957]] }, properties: { kind: 'hydrant_restriction' } }
    ] }
    ;(map?.getSource('parking') as maplibregl.GeoJSONSource)?.setData(data)
    ;(map?.getSource('hydrants') as maplibregl.GeoJSONSource)?.setData(hydrants)
    ;(map?.getSource('garages') as maplibregl.GeoJSONSource)?.setData(garageGeoJSON(demoGarages))
    setParking(data.features as ParkingFeature[])
    setGarages(demoGarages)
    setIsDemo(true)
    setMessage('Preview mode • connect PostgreSQL for live NYC curb classifications')
  }, [])

  const loadViewport = useCallback(async () => {
    const map = mapRef.current
    if (!map?.getSource('parking')) return
    viewportAbortRef.current?.abort()
    const controller = new AbortController()
    viewportAbortRef.current = controller
    const bounds = map.getBounds()
    const zoom = map.getZoom()
    const parkingSource = map.getSource('parking') as maplibregl.GeoJSONSource
    const hydrantSource = map.getSource('hydrants') as maplibregl.GeoJSONSource
    const proximitySource = map.getSource('proximity') as maplibregl.GeoJSONSource

    if (modeRef.current === 'garage') {
      parkingSource.setData(empty)
      hydrantSource.setData(empty)
      proximitySource.setData(empty)
      setParking([])
      const center = map.getCenter()
      try {
        const response = await fetch(`/api/garages/near?lat=${center.lat}&lng=${center.lng}&radius=1800`, { signal: controller.signal })
        if (!response.ok) throw new Error('garages unavailable')
        const payload = await response.json() as { facilities: Garage[] }
        setGarages(payload.facilities)
        ;(map.getSource('garages') as maplibregl.GeoJSONSource).setData(garageGeoJSON(payload.facilities))
        setIsDemo(false)
        setMessage(`${payload.facilities.length} known facilities near the map center`)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        showDemo()
      }
      return
    }

    if (zoom < CURB_MIN_ZOOM) {
      parkingSource.setData(empty)
      hydrantSource.setData(empty)
      proximitySource.setData(empty)
      setParking([])
      setSelected(null)
      setIsDemo(false)
      setMessage(`Zoom in to street level to load nearby parking guidance`)
      return
    }

    const center = map.getCenter()
    const centerCoordinates: [number, number] = [center.lng, center.lat]
    const horizontalRadius = distanceMeters(centerCoordinates, [bounds.getEast(), center.lat])
    const verticalRadius = distanceMeters(centerCoordinates, [center.lng, bounds.getNorth()])
    const radiusMeters = Math.round(Math.min(MAX_PROXIMITY_RADIUS_METERS, Math.max(MIN_PROXIMITY_RADIUS_METERS, Math.min(horizontalRadius, verticalRadius) * .92)))
    proximitySource.setData(proximityCircle(centerCoordinates, radiusMeters))

    try {
      const params = new URLSearchParams({
        minLat: String(bounds.getSouth()), minLng: String(bounds.getWest()),
        maxLat: String(bounds.getNorth()), maxLng: String(bounds.getEast()),
        centerLat: String(center.lat), centerLng: String(center.lng),
        radiusMeters: String(radiusMeters), zoom: String(zoom)
      })
      const response = await fetch(`/api/parking/viewport?${params}`, { signal: controller.signal })
      if (!response.ok) throw new Error('viewport unavailable')
      const data = await response.json() as FeatureCollection<LineString, ParkingProperties> & { returned: number; clipped: boolean }
      parkingSource.setData(data)
      setParking(data.features)
      setIsDemo(false)
      setMessage(`${data.returned} nearby curbs within ${radiusMeters} m • ${data.clipped ? 'zoom in for complete detail' : 'live proximity'}`)

      if (zoom >= HYDRANT_MIN_ZOOM) {
        const responseHydrants = await fetch(`/api/hydrants/viewport?minLat=${bounds.getSouth()}&minLng=${bounds.getWest()}&maxLat=${bounds.getNorth()}&maxLng=${bounds.getEast()}`, { signal: controller.signal })
        if (responseHydrants.ok) hydrantSource.setData(await responseHydrants.json())
      } else hydrantSource.setData(empty)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      showDemo()
    }
  }, [showDemo])

  useEffect(() => {
    if (!entered || !container.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: container.current,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: demoCenter,
      zoom: 15,
      minZoom: 11.5,
      maxZoom: 20,
      maxBounds: [[-74.32, 40.45], [-73.65, 40.95]]
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    let initialized = false
    const initializeMap = () => {
      if (initialized || !map.getStyle()) return
      try {
        map.addSource('parking', { type: 'geojson', data: empty })
        map.addSource('hydrants', { type: 'geojson', data: empty })
        map.addSource('garages', { type: 'geojson', data: empty })
        map.addSource('proximity', { type: 'geojson', data: empty })
        map.addLayer({ id: 'proximity-fill', type: 'fill', source: 'proximity', minzoom: CURB_MIN_ZOOM, paint: { 'fill-color': '#b6d8f6', 'fill-opacity': .08 } })
        map.addLayer({ id: 'proximity-line', type: 'line', source: 'proximity', minzoom: CURB_MIN_ZOOM, paint: { 'line-color': '#71819f', 'line-width': 2, 'line-opacity': .55, 'line-dasharray': [2, 2] } })
        map.addLayer({ id: 'parking', type: 'line', source: 'parking', minzoom: CURB_MIN_ZOOM, paint: { 'line-color': ['coalesce', ['get', 'color'], '#8D93A6'], 'line-width': ['interpolate', ['linear'], ['zoom'], 16, 5, 20, 11], 'line-opacity': .94 } })
        map.addLayer({ id: 'hydrant-restrictions', type: 'line', source: 'hydrants', minzoom: HYDRANT_MIN_ZOOM, filter: ['==', ['get', 'kind'], 'hydrant_restriction'], paint: { 'line-color': '#D64545', 'line-width': 10, 'line-opacity': .95 } })
        const hydrantImage = new Image()
        hydrantImage.onload = () => {
          if (!map.hasImage('hydrant-icon')) map.addImage('hydrant-icon', hydrantImage)
          if (!map.getLayer('hydrants')) map.addLayer({
            id: 'hydrants', type: 'symbol', source: 'hydrants', minzoom: HYDRANT_MIN_ZOOM,
            filter: ['==', ['get', 'kind'], 'hydrant'],
            layout: {
              'visibility': modeRef.current === 'street' ? 'visible' : 'none',
              'icon-image': 'hydrant-icon',
              'icon-size': ['interpolate', ['linear'], ['zoom'], 19, .18, 20, .25],
              'icon-allow-overlap': true
            }
          })
        }
        hydrantImage.src = '/hydrant.png'
        map.addLayer({ id: 'garages', type: 'circle', source: 'garages', layout: { visibility: 'none' }, paint: { 'circle-radius': 10, 'circle-color': '#59657D', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } })
      } catch (error) {
        console.error('Map overlay initialization failed', error)
        return
      }
      initialized = true
      map.on('click', 'parking', event => setSelected((event.features?.[0] as unknown as ParkingFeature) ?? null))
      map.on('mouseenter', 'parking', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'parking', () => { map.getCanvas().style.cursor = '' })
      void loadViewport()
    }
    map.on('load', initializeMap)
    map.on('style.load', initializeMap)
    map.on('styledata', initializeMap)
    map.on('render', initializeMap)
    const readyTimer = window.setInterval(() => {
      initializeMap()
      if (initialized) window.clearInterval(readyTimer)
    }, 100)
    map.on('moveend', () => void loadViewport())
    return () => { viewportAbortRef.current?.abort(); window.clearInterval(readyTimer); map.remove(); mapRef.current = null }
  }, [entered, loadViewport])

  useEffect(() => {
    modeRef.current = mode
    setSelected(null)
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    map.setLayoutProperty('parking', 'visibility', mode === 'street' ? 'visible' : 'none')
    map.setLayoutProperty('proximity-fill', 'visibility', mode === 'street' ? 'visible' : 'none')
    map.setLayoutProperty('proximity-line', 'visibility', mode === 'street' ? 'visible' : 'none')
    if (map.getLayer('hydrants')) map.setLayoutProperty('hydrants', 'visibility', mode === 'street' ? 'visible' : 'none')
    map.setLayoutProperty('hydrant-restrictions', 'visibility', mode === 'street' ? 'visible' : 'none')
    map.setLayoutProperty('garages', 'visibility', mode === 'garage' ? 'visible' : 'none')
    void loadViewport()
  }, [mode, loadViewport])

  useEffect(() => {
    if (!entered || query.trim().length < 2) { setSuggestions([]); return }
    if (query === selectedQueryRef.current) { setSuggestions([]); return }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search/autocomplete?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        const payload = await response.json()
        setSuggestions(payload.features ?? [])
      } catch { setSuggestions([]) }
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [entered, query])

  const choosePlace = (place: Place) => {
    const [lng, lat] = place.geometry.coordinates
    const label = place.properties.label ?? place.properties.name ?? ''
    selectedQueryRef.current = label
    setQuery(label)
    setSuggestions([])
    mapRef.current?.flyTo({ center: [lng, lat], zoom: 16.5, duration: 1100 })
  }

  const submitSearch = async () => {
    if (suggestions[0]) { choosePlace(suggestions[0]); return }
    if (!query.trim()) return
    try {
      const response = await fetch(`/api/search?text=${encodeURIComponent(query)}`)
      const payload = await response.json()
      if (payload.features?.[0]) choosePlace(payload.features[0])
    } catch { mapRef.current?.flyTo({ center: demoCenter, zoom: 16, duration: 900 }) }
  }

  const focusParking = (feature: ParkingFeature) => {
    setSelected(feature)
    const coordinates = feature.geometry.coordinates
    if (coordinates.length) mapRef.current?.flyTo({ center: coordinates[Math.floor(coordinates.length / 2)] as [number, number], zoom: 18, duration: 850 })
  }

  const focusGarage = (garage: Garage) => mapRef.current?.flyTo({ center: [garage.longitude, garage.latitude], zoom: 18, duration: 850 })

  if (!entered) return <main className="landing">
    <section className="welcome">
      <img src="/pigeon.png" alt="Pidge pigeon" />
      <h1>Pidge</h1>
      <button onClick={() => {
        setEntered(true)
        setParking([])
        setGarages([])
        setIsDemo(false)
        setMessage('Zoom in to street level to load nearby parking guidance')
      }}>Continue as guest</button>
    </section>
  </main>

  return <main className="app-shell">
    <div ref={container} className="map" />
    <header className="search-panel">
      <div className="brand"><img src="/pigeon.png" alt="" /><b>Pidge</b>{isDemo && <span>Preview</span>}</div>
      <div className="search-row">
        <input value={query} onChange={event => { selectedQueryRef.current = ''; setQuery(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void submitSearch() }} placeholder="Where are you going?" />
        <button onClick={() => void submitSearch()} aria-label="Go to destination">→</button>
      </div>
      {suggestions.length > 0 && <div className="suggestions">{suggestions.map((suggestion, index) => <button key={`${suggestion.properties.label}-${index}`} onClick={() => choosePlace(suggestion)}>{suggestion.properties.label}</button>)}</div>}
      <div className="modes">
        <button className={mode === 'street' ? 'active' : ''} onClick={() => setMode('street')}>Streets</button>
        <button className={mode === 'garage' ? 'active' : ''} onClick={() => setMode('garage')}>Garages</button>
        <button className="list-toggle" onClick={() => setShowList(value => !value)}>{showList ? 'Hide list' : 'Show list'}</button>
      </div>
      <small>{message}</small>
    </header>

    {showList && <aside className="results">
      <div className="results-heading"><h2>{mode === 'street' ? 'Visible curbs' : 'Known facilities'}</h2><span>{mode === 'street' ? parking.length : garages.length}</span></div>
      <div className="result-scroll">
        {mode === 'street' ? displayItems.map(feature => <button key={String(feature.id)} onClick={() => focusParking(feature)}>
          <i style={{ background: feature.properties.color }} /><span><b>{feature.properties.onStreet ?? 'Unnamed curb'}</b><small>{feature.properties.status.replace('_', ' ')}</small></span>
          {countdown(feature.properties.nextChange, now) && <time>{countdown(feature.properties.nextChange, now)}</time>}
        </button>) : garages.map(garage => <button key={garage.id} onClick={() => focusGarage(garage)}><i className="garage-dot">P</i><span><b>{garage.name}</b><small>{garage.address}</small></span></button>)}
      </div>
      {mode === 'garage' && <p>Licensed facility records do not guarantee real-time space or pricing.</p>}
    </aside>}

    {selected && <aside className="detail">
      <button className="close" onClick={() => setSelected(null)} aria-label="Close curb details">×</button>
      <span className={`status ${selected.properties.status}`}>{selected.properties.status.replace('_', ' ')}</span>
      <h2>{selected.properties.onStreet || 'Selected curb'}</h2>
      <p>{selected.properties.ruleSummary || selected.properties.reason || 'No reliable active rule was found.'}</p>
      {countdown(selected.properties.nextChange, now) && <div className="countdown"><span>Rule changes in</span><strong>{countdown(selected.properties.nextChange, now)}</strong></div>}
      <small>Confidence {Math.round((selected.properties.confidence ?? 0) * 100)}%</small>
    </aside>}
  </main>
}
