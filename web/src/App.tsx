import { useEffect, useRef, useState } from 'react'
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

type Place = { properties: { label?: string; name?: string }; geometry: { coordinates: [number, number] } }
type ParkingFeature = Feature<LineString, { status: string; color: string; ruleSummary?: string; reason?: string; confidence: number; nextChange?: string; onStreet?: string }>
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }

export default function App() {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const modeRef = useRef<'street' | 'garage'>('street')
  const [entered, setEntered] = useState(false)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Place[]>([])
  const [selected, setSelected] = useState<ParkingFeature | null>(null)
  const [mode, setMode] = useState<'street' | 'garage'>('street')
  const [showList, setShowList] = useState(true)
  const [message, setMessage] = useState('Move the map to load visible parking data.')

  useEffect(() => { modeRef.current = mode; void loadViewport() }, [mode])

  const loadViewport = async () => {
    const map = mapRef.current; if (!map) return
    const b = map.getBounds()
    try {
      const response = await fetch(`/api/parking/viewport?minLat=${b.getSouth()}&minLng=${b.getWest()}&maxLat=${b.getNorth()}&maxLng=${b.getEast()}`)
      if (!response.ok) throw new Error()
      const data = await response.json()
      ;(map.getSource('parking') as maplibregl.GeoJSONSource)?.setData(data)
      setMessage(`${data.returned} visible curb segments • ${data.clipped ? 'zoom in for complete detail' : 'live viewport'}`)
      if (map.getZoom() >= 18) {
        const h = await fetch(`/api/hydrants/viewport?minLat=${b.getSouth()}&minLng=${b.getWest()}&maxLat=${b.getNorth()}&maxLng=${b.getEast()}`)
        if (h.ok) (map.getSource('hydrants') as maplibregl.GeoJSONSource)?.setData(await h.json())
      } else (map.getSource('hydrants') as maplibregl.GeoJSONSource)?.setData(empty)
      if (modeRef.current === 'garage') {
        const c = map.getCenter(); const g = await fetch(`/api/garages/near?lat=${c.lat}&lng=${c.lng}&radius=1800`)
        if (g.ok) {
          const payload = await g.json(); const features = (payload.facilities ?? []).flatMap((facility: Record<string, any>, i: number) => {
            const coords = facility.location?.coordinates ?? (facility.latitude && facility.longitude ? [Number(facility.longitude), Number(facility.latitude)] : null)
            return coords ? [{ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: coords }, properties: { name: facility.business_name ?? facility.entity_name ?? 'Licensed parking facility' } }] : []
          })
          ;(map.getSource('garages') as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features })
        }
      } else (map.getSource('garages') as maplibregl.GeoJSONSource)?.setData(empty)
    } catch { setMessage('Parking API unavailable. Streets remain unclassified.') }
  }

  useEffect(() => {
    if (!entered || !container.current || mapRef.current) return
    const map = new maplibregl.Map({ container: container.current, style: 'https://tiles.openfreemap.org/styles/positron', center: [-73.9855, 40.7484], zoom: 14 })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('load', () => {
      map.addSource('parking', { type: 'geojson', data: empty })
      map.addSource('hydrants', { type: 'geojson', data: empty })
      map.addSource('garages', { type: 'geojson', data: empty })
      map.addLayer({ id: 'parking', type: 'line', source: 'parking', paint: { 'line-color': ['coalesce', ['get', 'color'], '#8d93a6'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 8], 'line-opacity': .9 } })
      map.addLayer({ id: 'hydrants', type: 'circle', source: 'hydrants', minzoom: 18, paint: { 'circle-radius': 7, 'circle-color': '#d64545', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      map.addLayer({ id: 'garages', type: 'circle', source: 'garages', paint: { 'circle-radius': 9, 'circle-color': '#59657d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } })
      map.on('click', 'parking', e => setSelected((e.features?.[0] as unknown as ParkingFeature) ?? null))
      map.on('mouseenter', 'parking', () => map.getCanvas().style.cursor = 'pointer')
      map.on('mouseleave', 'parking', () => map.getCanvas().style.cursor = '')
      void loadViewport()
    })
    map.on('moveend', () => void loadViewport())
    return () => { map.remove(); mapRef.current = null }
  }, [entered])

  useEffect(() => {
    if (query.trim().length < 2) { setSuggestions([]); return }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try { const r = await fetch(`/api/search/autocomplete?q=${encodeURIComponent(query)}`, { signal: controller.signal }); const j = await r.json(); setSuggestions(j.features ?? []) } catch { /* superseded */ }
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query])

  const choose = (place: Place) => {
    const [lng, lat] = place.geometry.coordinates
    setQuery(place.properties.label ?? place.properties.name ?? '')
    setSuggestions([]); setEntered(true)
    window.setTimeout(() => mapRef.current?.flyTo({ center: [lng, lat], zoom: 16, duration: 1200 }), 50)
  }

  if (!entered) return <main className="landing">
    <section className="welcome">
      <img src="/pigeon.png" alt="Pidge pigeon" />
      <h1>Pidge</h1>
      <p>NYC curb guidance that explains what the signs mean right now.</p>
      <button onClick={() => setEntered(true)}>Continue as guest</button>
      <span>Account sync will return after parking accuracy is verified.</span>
    </section>
  </main>

  return <main className="app-shell">
    <div ref={container} className="map" />
    <header className="search-panel">
      <div className="brand"><img src="/pigeon.png" alt="" /><b>Pidge</b></div>
      <div className="search-row"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Where are you going?" /><button aria-label="Search selected place">→</button></div>
      {suggestions.length > 0 && <div className="suggestions">{suggestions.map((s, i) => <button key={i} onClick={() => choose(s)}>{s.properties.label}</button>)}</div>}
      <div className="modes"><button className={mode === 'street' ? 'active' : ''} onClick={() => setMode('street')}>Streets</button><button className={mode === 'garage' ? 'active' : ''} onClick={() => setMode('garage')}>Garages</button><button onClick={() => setShowList(v => !v)}>{showList ? 'Hide list' : 'Show list'}</button></div>
      <small>{message}</small>
    </header>
    {showList && <aside className="results"><h2>{mode === 'street' ? 'Visible curb guidance' : 'Known facilities'}</h2><p>{mode === 'street' ? 'Tap a colored street for its active rule and confidence.' : 'Garage records do not guarantee live price or availability.'}</p></aside>}
    {selected && <aside className="detail"><button className="close" onClick={() => setSelected(null)}>×</button><span className={`status ${selected.properties.status}`}>{selected.properties.status.replace('_', ' ')}</span><h2>{selected.properties.onStreet || 'Selected curb'}</h2><p>{selected.properties.ruleSummary || selected.properties.reason || 'No reliable active rule was found.'}</p><small>Confidence {Math.round((selected.properties.confidence ?? 0) * 100)}%</small></aside>}
  </main>
}
