import { useEffect, useMemo, useState } from 'react'
import {
  autocompleteDestination,
  defaultArrivalInput,
  defaultDepartureInput,
  fetchPlan,
  planningInterval,
  searchDestination,
} from '../api'
import type { ParkingPlan, ParkingPreferences, Place } from '../types'
import LoadingOverlay from './LoadingOverlay'

const TRANSIT_PILOT_ENABLED = import.meta.env.VITE_ENABLE_TRANSIT === 'true'
const CITY_APPROVED_RELEASE = import.meta.env.VITE_CITY_APPROVED_RELEASE === 'true'

type Props = {
  initialPlan: ParkingPlan | null
  isOnline?: boolean
  onMapIntent?: () => void
  onPlan: (plan: ParkingPlan) => void
}

type PlaceFieldProps = {
  id: string
  label: string
  placeholder: string
  initialPlace: Place | null
  initialLabel: string
  onChange: (place: Place | null, label: string) => void
  allowCurrentLocation?: boolean
}

function PlaceField({ id, label, placeholder, initialPlace, initialLabel, onChange, allowCurrentLocation = false }: PlaceFieldProps) {
  const [query, setQuery] = useState(initialLabel)
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(initialPlace)
  const [selectedLabel, setSelectedLabel] = useState(initialLabel)
  const [suggestions, setSuggestions] = useState<Place[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle')

  useEffect(() => {
    if (query.trim().length < 2 || query === selectedLabel) {
      setSuggestions([])
      setSearchState('idle')
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setSearchState('loading')
      try {
        const matches = await autocompleteDestination(query, controller.signal)
        if (controller.signal.aborted) return
        setSuggestions(matches)
        setActiveIndex(0)
        setSearchState(matches.length > 0 ? 'idle' : 'empty')
      } catch {
        if (!controller.signal.aborted) {
          setSuggestions([])
          setSearchState('error')
        }
      }
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, selectedLabel])

  const choosePlace = (place: Place) => {
    const nextLabel = place.properties.label ?? place.properties.name ?? ''
    setQuery(nextLabel)
    setSelectedLabel(nextLabel)
    setSelectedPlace(place)
    setSuggestions([])
    setSearchState('idle')
    onChange(place, nextLabel)
  }

  const resolvePlace = async (): Promise<Place | null> => {
    const trimmedQuery = query.trim()
    if (selectedPlace && query === selectedLabel) return selectedPlace
    if (trimmedQuery.length < 2) {
      setSearchState('empty')
      return null
    }
    setSearchState('loading')
    try {
      const place = suggestions[0] ?? await searchDestination(trimmedQuery)
      if (place) {
        choosePlace(place)
        return place
      }
      setSuggestions([])
      setSearchState('empty')
      return null
    } catch {
      setSuggestions([])
      setSearchState('error')
      return null
    }
  }

  const useCurrentLocation = () => {
    setLocationError(null)
    if (!navigator.geolocation) {
      setLocationError('Location is not available in this browser.')
      return
    }
    navigator.geolocation.getCurrentPosition(position => {
      const place: Place = {
        properties: { label: 'Current location' },
        geometry: { coordinates: [position.coords.longitude, position.coords.latitude] },
      }
      choosePlace(place)
    }, () => setLocationError('We could not use your location. Enter a starting point instead.'), {
      enableHighAccuracy: false,
      timeout: 8_000,
      maximumAge: 60_000,
    })
  }

  return <div className="place-field">
    <div className="planner-label-row">
      <label className="planner-label" htmlFor={id}>{label}</label>
      {allowCurrentLocation && <button type="button" className="location-button" onClick={useCurrentLocation}>Use my location</button>}
    </div>
    <div className="planner-search">
      <input
        id={id}
        role="combobox"
        value={query}
        onChange={event => {
          setSelectedPlace(null)
          setSelectedLabel('')
          setQuery(event.target.value)
          setSearchState('idle')
          onChange(null, event.target.value)
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && suggestions.length > 0) {
            event.preventDefault()
            setActiveIndex(index => Math.min(index + 1, suggestions.length - 1))
          } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
            event.preventDefault()
            setActiveIndex(index => Math.max(index - 1, 0))
          } else if (event.key === 'Escape') {
            setSuggestions([])
          } else if (event.key === 'Enter') {
            event.preventDefault()
            const active = suggestions[activeIndex]
            if (active) choosePlace(active)
            else void resolvePlace()
          }
        }}
        placeholder={placeholder}
        autoComplete="street-address"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={suggestions.length > 0 ? `${id}-suggestions` : undefined}
        aria-activedescendant={suggestions.length > 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-describedby={searchState !== 'idle' ? `${id}-search-status` : undefined}
      />
      <button type="button" disabled={query.trim().length < 2} onClick={() => void resolvePlace()} aria-label={`Find ${label.toLowerCase()}`}>→</button>
    </div>
    {suggestions.length > 0 && <div id={`${id}-suggestions`} className="planner-suggestions suggestions" role="listbox" aria-label={`${label} suggestions`}>
      {suggestions.map((suggestion, index) => <button
        id={`${id}-option-${index}`}
        type="button"
        role="option"
        aria-selected={activeIndex === index}
        key={`${suggestion.properties.label}-${index}`}
        onMouseDown={event => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => choosePlace(suggestion)}
      >{suggestion.properties.label}</button>)}
    </div>}
    {searchState === 'loading' && <p id={`${id}-search-status`} className="field-status" role="status">Searching NYC addresses…</p>}
    {searchState === 'empty' && <p id={`${id}-search-status`} className="field-status" role="status">No matching NYC location yet. Add a street, borough, or ZIP code and try again.</p>}
    {searchState === 'error' && <p id={`${id}-search-status`} className="field-error" role="alert">Address suggestions are temporarily unavailable. You can still submit the typed destination to try a precise search.</p>}
    {locationError && <p className="field-error" role="alert">{locationError}</p>}
  </div>
}

export default function ParkingPlanner({ initialPlan, isOnline = true, onMapIntent, onPlan }: Props) {
  const initialArrival = initialPlan?.arrivalInput ?? defaultArrivalInput()
  const [destination, setDestination] = useState<Place | null>(initialPlan?.place ?? null)
  const [destinationLabel, setDestinationLabel] = useState(initialPlan?.label ?? '')
  const [origin, setOrigin] = useState<Place | null>(initialPlan?.origin ?? null)
  const [originLabel, setOriginLabel] = useState(initialPlan?.originLabel ?? '')
  const [arrivalInput, setArrivalInput] = useState(initialArrival)
  const [departureInput, setDepartureInput] = useState(initialPlan?.departureInput ?? defaultDepartureInput(initialArrival))
  const [allowPaid, setAllowPaid] = useState(initialPlan?.preferences.allowPaid ?? true)
  const [allowGarages, setAllowGarages] = useState(initialPlan?.preferences.allowGarages ?? true)
  const [maxWalkMinutes, setMaxWalkMinutes] = useState(initialPlan?.preferences.maxWalkMinutes ?? 10)
  const [allowTransit, setAllowTransit] = useState(TRANSIT_PILOT_ENABLED && (initialPlan?.preferences.allowTransit ?? false))
  const [accessibleOnly, setAccessibleOnly] = useState(initialPlan?.preferences.accessibleOnly ?? false)
  const [isPlanning, setIsPlanning] = useState(false)
  const [plannerError, setPlannerError] = useState<string | null>(null)

  const planParking = async () => {
    // Load the large map runtime while the plan request is in flight instead of
    // competing with the destination form during initial page startup.
    onMapIntent?.()
    setIsPlanning(true)
    setPlannerError(null)
    try {
      let resolvedDestination = destination
      let resolvedDestinationLabel = destinationLabel
      if (!resolvedDestination) {
        const query = destinationLabel.trim()
        if (query.length < 2) throw new Error('Enter a destination to continue.')
        resolvedDestination = await searchDestination(query)
        if (!resolvedDestination) throw new Error('We could not find that NYC destination. Add a street, borough, or ZIP code and try again.')
        resolvedDestinationLabel = resolvedDestination.properties.label ?? resolvedDestination.properties.name ?? query
        setDestination(resolvedDestination)
        setDestinationLabel(resolvedDestinationLabel)
      }

      let resolvedOrigin = origin
      let resolvedOriginLabel = originLabel
      if (allowTransit && !resolvedOrigin) {
        const query = originLabel.trim()
        if (query.length < 2) throw new Error('Enter a starting point for round-trip park-and-ride.')
        resolvedOrigin = await searchDestination(query)
        if (!resolvedOrigin) throw new Error('We could not find that starting point. Add a street, borough, or ZIP code and try again.')
        resolvedOriginLabel = resolvedOrigin.properties.label ?? resolvedOrigin.properties.name ?? query
        setOrigin(resolvedOrigin)
        setOriginLabel(resolvedOriginLabel)
      }
      const interval = planningInterval(arrivalInput, departureInput)
      const preferences: ParkingPreferences = {
        allowPaid,
        allowGarages,
        maxWalkMinutes,
        allowTransit,
        accessibleOnly,
        transitModes: ['SUBWAY', 'BUS', 'SIR', 'LIRR', 'METRO_NORTH'],
      }
      const payload = await fetchPlan(resolvedDestination, resolvedOrigin, interval, preferences)
      onPlan({
        place: resolvedDestination,
        origin: resolvedOrigin,
        label: resolvedDestinationLabel,
        originLabel: resolvedOriginLabel,
        arrivalInput,
        departureInput,
        arrivalIso: interval.start,
        departureIso: interval.end,
        preferences,
        recommendations: payload.options,
        availability: payload.availability,
        preferredRadiusMeters: payload.preferredRadiusMeters,
        searchRadiusMeters: payload.searchRadiusMeters,
        warnings: payload.warnings,
        disclaimer: payload.disclaimer,
      })
    } catch (error) {
      setPlannerError(error instanceof Error ? error.message : 'Unable to plan parking.')
    } finally {
      setIsPlanning(false)
    }
  }

  const intervalDescription = useMemo(() => {
    const start = new Date(arrivalInput)
    const end = new Date(departureInput)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      return 'Choose a valid arrival and leave time.'
    }
    return `Curb guidance will cover your complete stay from ${start.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} to ${end.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
  }, [arrivalInput, departureInput])

  return <main className="planner" aria-busy={isPlanning}>
    <header className="city-header">
      <a href="https://www.nyc.gov/" className="nyc-mark" aria-label="NYC government home">NYC</a>
      <span>{CITY_APPROVED_RELEASE ? 'Official website of the City of New York' : 'Prototype for City review — not an official NYC service'}</span>
      <span aria-label="Current language">English</span>
    </header>
    <section className="planner-content" aria-labelledby="planner-heading">
      <div className="planner-brand">
        <div><strong>NYC Parking Planner</strong><span>Advisory parking guidance</span></div>
        <img src="/pigeon.png" alt="Pidge, the parking guide" />
      </div>
      <div className="pilot-notice" role="note"><b>{CITY_APPROVED_RELEASE ? 'Public pilot' : 'Safety hold'}</b><span>Always check posted signs. Results do not guarantee an open space.</span></div>
      <div className="planner-heading">
        <small>PLAN YOUR PARKING</small>
        <h1 id="planner-heading">Where are you going?</h1>
        <p>Compare validated curb guidance and active licensed parking facilities for your complete stay.</p>
      </div>

      {!isOnline && <p className="offline-notice" role="status">Your device appears offline. You can keep editing; the planner will try the current sources when you submit.</p>}

      <PlaceField
        id="destination"
        label="Destination"
        placeholder="Address, landmark, or intersection"
        initialPlace={destination}
        initialLabel={destinationLabel}
        onChange={(place, label) => { setDestination(place); setDestinationLabel(label); setPlannerError(null) }}
      />

      {allowTransit && <PlaceField
        id="origin"
        label="Starting point"
        placeholder="Where will you start driving?"
        initialPlace={origin}
        initialLabel={originLabel}
        allowCurrentLocation
        onChange={(place, label) => { setOrigin(place); setOriginLabel(label); setPlannerError(null) }}
      />}

      <div className="planner-grid time-grid">
        <label className="preference-field" htmlFor="arrival-time">
          <span>Arrive at destination</span>
          <input id="arrival-time" type="datetime-local" step="900" value={arrivalInput} onChange={event => setArrivalInput(event.currentTarget.value)} />
        </label>
        <label className="preference-field" htmlFor="departure-time">
          <span>Leave destination</span>
          <input id="departure-time" type="datetime-local" step="900" value={departureInput} onChange={event => setDepartureInput(event.currentTarget.value)} />
        </label>
      </div>

      <fieldset className="preference-field walk-field">
        <legend>Maximum walk</legend>
        <div className="walk-options">
          {[5, 10, 15, 20].map(minutes => <button
            type="button"
            aria-pressed={maxWalkMinutes === minutes}
            className={maxWalkMinutes === minutes ? 'selected' : ''}
            key={minutes}
            onClick={() => setMaxWalkMinutes(minutes)}
          >{minutes} min</button>)}
        </div>
      </fieldset>

      <div className="preference-toggles" aria-label="Parking preferences">
        <button type="button" aria-label="Paid curb parking" aria-pressed={allowPaid} className={allowPaid ? 'selected' : ''} onClick={() => setAllowPaid(value => !value)}>
          <i className="paid-swatch" /><span><b>Paid curbs</b><small>Include metered parking</small></span>
        </button>
        <button type="button" aria-label="Licensed parking facilities" aria-pressed={allowGarages} className={allowGarages ? 'selected' : ''} onClick={() => setAllowGarages(value => !value)}>
          <i>P</i><span><b>Licensed facilities</b><small>No live price or availability</small></span>
        </button>
        <button type="button" disabled={!TRANSIT_PILOT_ENABLED} aria-label="Round-trip park-and-ride" aria-pressed={allowTransit} className={allowTransit ? 'selected' : ''} onClick={() => setAllowTransit(value => !value)}>
          <i>◆</i><span><b>Park + transit</b><small>{TRANSIT_PILOT_ENABLED ? 'Subway, bus, SIR, LIRR, Metro-North' : 'Disabled pending the transit validation gate'}</small></span>
        </button>
        {allowTransit && <button type="button" aria-label="Step-free transit routes only" aria-pressed={accessibleOnly} className={accessibleOnly ? 'selected' : ''} onClick={() => setAccessibleOnly(value => !value)}>
          <i>♿</i><span><b>Step-free routes</b><small>Exclude routes without a validated step-free path</small></span>
        </button>}
      </div>

      <p className="arrival-note">{intervalDescription}</p>
      {!destination && destinationLabel.trim().length >= 2 && <p className="planner-action-note">You can submit the typed destination; the planner will resolve it before checking parking.</p>}
      {plannerError && <p className="planner-error" role="alert">{plannerError}</p>}
      <button type="button" className="plan-submit" disabled={isPlanning || destinationLabel.trim().length < 2} onClick={() => void planParking()}>
        {isPlanning ? 'Checking parking sources…' : 'Find parking options'}<span aria-hidden="true">→</span>
      </button>
    </section>
    <footer className="city-footer">
      <nav aria-label="Policies"><a href="/privacy.html">Privacy</a><a href="/accessibility.html">Accessibility</a><a href="/terms.html">Terms</a><a href="/data-sources.html">Data sources</a></nav>
      <p>NYC Parking Planner provides advisory guidance only.</p>
    </footer>
    {isPlanning && <LoadingOverlay
      title="Building your parking plan"
      detail="Checking curb rules, source freshness, licensed facilities, and your complete arrival-to-leave interval."
    />}
  </main>
}
