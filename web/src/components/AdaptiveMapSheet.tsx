import { useEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { countdown } from '../countdown'
import { isFullParkingFeature } from '../types'
import type {
  Availability,
  Garage,
  Mode,
  ParkingPlan,
  ParkingStatus,
  ParkingViewportFeature,
  Recommendation,
  SheetSnap,
} from '../types'

type Props = {
  plan: ParkingPlan
  mode: Mode
  snap: SheetSnap
  availability: Availability | null
  parking: ParkingViewportFeature[]
  garages: Garage[]
  selectedCurb: ParkingViewportFeature | null
  isCurbDetailLoading?: boolean
  curbDetailError?: string | null
  selectedGarage: Garage | null
  selectedRecommendation: Recommendation | null
  message: string
  error: string | null
  isLoading: boolean
  isRefreshing: boolean
  isOnline: boolean
  lastUpdated: Date | null
  now: number
  onModeChange: (mode: Mode) => void
  onSnapChange: (snap: SheetSnap) => void
  onChangePlan: () => void
  onRecenter: () => void
  onRetry: () => void
  onClearSelection: () => void
  onSelectCurb: (feature: ParkingViewportFeature) => void
  onSelectGarage: (garage: Garage) => void
  onSelectRecommendation: (option: Recommendation) => void
}

const SNAP_ORDER: SheetSnap[] = ['minimized', 'half', 'expanded']

function nextSnap(current: SheetSnap, direction: -1 | 1): SheetSnap {
  const index = SNAP_ORDER.indexOf(current)
  return SNAP_ORDER[Math.max(0, Math.min(SNAP_ORDER.length - 1, index + direction))]
}

function statusLabel(status: ParkingStatus): string {
  if (status === 'cannot_park') return 'Cannot park'
  if (status === 'paid') return 'Paid parking'
  if (status === 'free') return 'Likely free · verify signs'
  return 'Unknown — check signs'
}

function resultTitle(mode: Mode): string {
  if (mode === 'best') return 'Parking options'
  if (mode === 'street') return 'Visible curbs'
  return 'Licensed facilities'
}

function plannedParkingWindow(plan: ParkingPlan): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
  }).format(new Date(plan.arrivalIso))
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
  })
  return `${date}, ${time.format(new Date(plan.arrivalIso))}–${time.format(new Date(plan.departureIso))}`
}

export default function AdaptiveMapSheet(props: Props) {
  const {
    plan, mode, snap, availability, parking, garages,
    selectedCurb, isCurbDetailLoading = false, curbDetailError = null, selectedGarage, selectedRecommendation,
    message, error, isLoading, isRefreshing, isOnline, lastUpdated, now,
    onModeChange, onSnapChange, onChangePlan, onRecenter, onRetry,
    onClearSelection, onSelectCurb, onSelectGarage, onSelectRecommendation,
  } = props
  const dragStart = useRef<{ y: number; time: number } | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const selected = selectedCurb ?? selectedGarage ?? selectedRecommendation
  const count = mode === 'best' ? plan.recommendations.length : mode === 'street' ? parking.length : garages.length
  const curbLeadCount = plan.recommendations.filter(option => option.kind === 'curb').length
  const referenceLeadCount = plan.recommendations.filter(option => option.guidanceLevel === 'public_data_reference').length
  const freeLeadCount = plan.recommendations.filter(option => option.tier === 'free').length
  const paidLeadCount = plan.recommendations.filter(option => option.tier === 'paid').length
  const searchExpanded = (plan.searchRadiusMeters ?? 0) > (plan.preferredRadiusMeters ?? Number.POSITIVE_INFINITY)
  const orderedParking = useMemo(() => {
    const rank: Record<ParkingStatus, number> = { free: 0, paid: 1, cannot_park: 2, unknown: 3 }
    return [...parking].sort((left, right) => rank[left.properties.status] - rank[right.properties.status])
  }, [parking])

  useEffect(() => {
    if (selected && snap !== 'minimized') detailRef.current?.focus()
  }, [selected, snap])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (selected) onClearSelection()
      else onSnapChange('minimized')
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClearSelection, onSnapChange, selected])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!window.matchMedia('(max-width: 760px)').matches) return
    dragStart.current = { y: event.clientY, time: Date.now() }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current
    dragStart.current = null
    if (!start) return
    const delta = event.clientY - start.y
    const elapsed = Math.max(1, Date.now() - start.time)
    const velocity = delta / elapsed
    if (delta > 55 || velocity > 0.45) onSnapChange(nextSnap(snap, -1))
    else if (delta < -55 || velocity < -0.45) onSnapChange(nextSnap(snap, 1))
  }

  const latestText = lastUpdated
    ? `Refreshed ${lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'Waiting for source data'

  return <aside className={`map-interface snap-${snap}`} aria-label="Parking map controls">
    <div
      className="sheet-handle-zone"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { dragStart.current = null }}
      aria-hidden="true"
    ><span className="sheet-handle" /></div>

    <div className="sheet-peek">
      <div className="sheet-brand"><b>NYC</b><span>Parking Planner</span></div>
      <button type="button" className="peek-destination" onClick={onRecenter} aria-label={plan.recommendations.length > 0 ? 'Center map on best parking lead' : 'Center map on destination'}>
        <small>{mode === 'best' ? 'BEST PARKING LEAD' : mode === 'street' ? 'VISIBLE CURBS' : 'LICENSED FACILITIES'}</small>
        <strong>{selectedRecommendation?.title ?? selectedCurb?.properties.onStreet ?? selectedGarage?.name ?? plan.label}</strong>
      </button>
      <span className="result-count" aria-label={`${count} results`}>{count}</span>
      {snap === 'minimized' && <button type="button" className="sheet-icon-button" onClick={() => onSnapChange('half')} aria-label="Open parking panel">⌃</button>}
    </div>

    <div className="sheet-content" aria-hidden={snap === 'minimized'}>
      <div className="sheet-destination">
        <div><small>PLANNED DESTINATION</small><h1>{plan.label}</h1></div>
        <div className="destination-actions">
          <button type="button" onClick={onRecenter}>{plan.recommendations.length > 0 ? 'Best option' : 'Recenter'}</button>
          <button type="button" onClick={onChangePlan}>Change trip</button>
        </div>
      </div>

      <div className="sheet-toolbar">
        <div className="modes" aria-label="Parking view">
          {(['best', 'street', 'garage'] as const).map(value => <button
            type="button"
            key={value}
            aria-pressed={mode === value}
            className={mode === value ? 'active' : ''}
            onClick={() => onModeChange(value)}
          >{value === 'garage' ? 'Facilities' : value === 'street' ? 'Curbs' : 'Options'}</button>)}
        </div>
        <div className="sheet-level-actions">
          {snap !== 'half' && <button type="button" className="sheet-icon-button" onClick={() => onSnapChange('half')} aria-label="Set panel to half height">↕</button>}
          {snap !== 'expanded' && <button type="button" className="sheet-icon-button" onClick={() => onSnapChange('expanded')} aria-label="Expand parking panel">⌃</button>}
          <button type="button" className="sheet-icon-button" onClick={() => onSnapChange('minimized')} aria-label="Minimize parking panel">⌄</button>
        </div>
      </div>

      {!selected && <div className="parking-legend" aria-label="Parking color legend">
        <span><i className="cannot-park" />Red means cannot park</span>
        <span><i className="paid" />Yellow means paid parking</span>
        <span><i className="free" />Green means likely free · verify signs</span>
        <span><i className="unknown" />Gray means unknown — check signs</span>
        <span className="hydrant-reference"><i />Red ring: approximate 15 ft hydrant safety reference — verify the curb</span>
      </div>}

      {!selected && availability && <div className="availability-block">
        <b>{mode === 'best' ? 'Best parking leads' : 'Visible map totals'}</b>
        <div className="availability-strip" aria-label={mode === 'best' ? 'Planned area parking status totals' : 'Visible map parking status totals'}>
          {mode !== 'best' && <span><i className="cannot-park" />{availability.cannotPark} cannot park</span>}
          <span><i className="free" />{mode === 'best' ? freeLeadCount : availability.free} likely free</span>
          <span><i className="paid" />{mode === 'best' ? paidLeadCount : availability.paid} paid</span>
          {mode !== 'best' && <span><i className="unknown" />{availability.unknown} unknown</span>}
        </div>
        {mode === 'best' && <div className="coverage-summary">
          <b>{curbLeadCount} ranked curb {curbLeadCount === 1 ? 'lead' : 'leads'}</b>
          {freeLeadCount === 0 && curbLeadCount > 0 && <span>No supported likely-free curb matched this trip time, so paid alternatives are shown next.</span>}
          {searchExpanded && <span>Pidge expanded beyond the preferred walking area to find supported alternatives.</span>}
          {referenceLeadCount > 0 && <span>{referenceLeadCount} use official NYC meter blockface geometry and require an on-street sign check.</span>}
          {curbLeadCount === 0 && <span>{availability.unknown} nearby curb records remain gray until their evidence is complete.</span>}
        </div>}
      </div>}

      {!selected && plan.warnings.length > 0 && <div className="plan-warnings" role="status">
        {plan.warnings.map(warning => <p key={warning.code}>{warning.message}</p>)}
      </div>}

      {(!selected || error || isLoading || isRefreshing) && <div className={`live-status ${error ? 'has-error' : ''}`} role="status" aria-live="polite" aria-atomic="true">
        <span className={!isOnline ? 'live-dot offline' : isRefreshing ? 'live-dot refreshing' : 'live-dot'} />
        <div><b>{isLoading ? 'Loading parking sources…' : isRefreshing ? 'Refreshing visible map…' : error ?? message}</b><small>{isOnline ? latestText : 'Offline • current guidance requires a connection'}</small></div>
        {error && <button type="button" onClick={onRetry}>Retry</button>}
      </div>}

      <div className="sheet-results" ref={detailRef} tabIndex={-1}>
        {selectedCurb ? <CurbDetail
          feature={selectedCurb}
          now={now}
          isLoading={isCurbDetailLoading}
          error={curbDetailError}
          onBack={onClearSelection}
        />
          : selectedGarage ? <GarageDetail garage={selectedGarage} onBack={onClearSelection} />
            : selectedRecommendation ? <RecommendationDetail option={selectedRecommendation} plan={plan} now={now} onBack={onClearSelection} />
              : <ResultList
                mode={mode}
                title={resultTitle(mode)}
                recommendations={plan.recommendations}
                parking={orderedParking.slice(0, snap === 'expanded' ? 36 : 16)}
                totalParkingCount={parking.length}
                garages={garages}
                availability={availability}
                isLoading={isLoading}
                now={now}
                onModeChange={onModeChange}
                onChangePlan={onChangePlan}
                onSelectCurb={onSelectCurb}
                onSelectGarage={onSelectGarage}
                onSelectRecommendation={onSelectRecommendation}
              />}
      </div>
    </div>
  </aside>
}

function ResultList(props: {
  mode: Mode
  title: string
  recommendations: Recommendation[]
  parking: ParkingViewportFeature[]
  totalParkingCount: number
  garages: Garage[]
  availability: Availability | null
  isLoading: boolean
  now: number
  onModeChange: (mode: Mode) => void
  onChangePlan: () => void
  onSelectCurb: (feature: ParkingViewportFeature) => void
  onSelectGarage: (garage: Garage) => void
  onSelectRecommendation: (option: Recommendation) => void
}) {
  const {
    mode, title, recommendations, parking, totalParkingCount, garages, availability, isLoading, now,
    onModeChange, onChangePlan, onSelectCurb, onSelectGarage, onSelectRecommendation,
  } = props
  const count = mode === 'best' ? recommendations.length : mode === 'street' ? totalParkingCount : garages.length
  const unknownOnly = mode === 'best' && count === 0 && (availability?.unknown ?? 0) > 0
  const reviewedCount = availability
    ? availability.free + availability.paid + availability.cannotPark + availability.unknown
    : 0
  return <section className="results-list" aria-labelledby="results-title">
    <div className="results-heading"><div><small>{mode === 'best' ? 'RANKED FOR THE COMPLETE STAY' : 'VISIBLE MAP AREA'}</small><h2 id="results-title">{title}</h2></div><span>{count}</span></div>
    <div className="result-scroll">
      {mode === 'best' && recommendations.map(option => <button type="button" className="recommendation-row" key={option.id} onClick={() => onSelectRecommendation(option)}>
        <i className={`tier-marker ${option.tier}`}>{option.kind === 'licensed_facility' ? 'P' : option.kind === 'park_and_ride' ? '◆' : ''}</i>
        <span><b>{option.title}</b><small>{option.kind === 'curb'
          ? option.guidanceLevel === 'public_data_reference'
            ? `${statusLabel(option.status)} lead · verify posted signs`
            : statusLabel(option.status)
          : option.kind === 'licensed_facility' ? 'Active licensed facility' : 'Round-trip park + transit'}</small></span>
        <time>{option.walkMinutes} min walk</time>
      </button>)}
      {mode === 'street' && parking.map(feature => <button type="button" key={String(feature.id)} onClick={() => onSelectCurb(feature)}>
        <i className="curb-swatch" style={{ background: feature.properties.color }} />
        <span><b>{feature.properties.onStreet ?? 'Unnamed curb'}</b><small>{statusLabel(feature.properties.status)}{feature.properties.sideOfStreet ? ` · ${feature.properties.sideOfStreet} side` : ''}</small></span>
        {countdown(feature.properties.nextChange ?? undefined, now) && <time>{countdown(feature.properties.nextChange ?? undefined, now)}</time>}
      </button>)}
      {mode === 'garage' && garages.map(garage => <button type="button" key={garage.id} onClick={() => onSelectGarage(garage)}>
        <i className="garage-dot">P</i><span><b>{garage.name}</b><small>Active license {garage.licenseNumber} · {garage.address}</small></span>
      </button>)}
      {count === 0 && !isLoading && (unknownOnly ? <div className="coverage-empty">
        <div className="coverage-empty-colors" aria-hidden="true"><i className="paid" /><i className="free" /></div>
        <b>No supported likely-free or paid options yet</b>
        <p>We reviewed {reviewedCount} nearby curb records for the complete stay. {availability?.unknown} still need verified geometry or rule evidence, so they remain gray.</p>
        <div>
          <button type="button" onClick={() => onModeChange('street')}>Review all {reviewedCount} curb references</button>
          <button type="button" onClick={onChangePlan}>Adjust trip</button>
        </div>
      </div> : <div className="empty-results">
        <b>No eligible options in this area</b>
        <p>Move the map or adjust the trip to search a different walking area.</p>
        <button type="button" onClick={onChangePlan}>Adjust trip</button>
      </div>)}
    </div>
    <p className="results-disclaimer">{mode === 'street'
      ? `${parking.length < totalParkingCount ? `Showing ${parking.length} of ${totalParkingCount} curb records in this panel. ` : ''}Colors describe the selected interval, but a colored curb reference is not necessarily recommendation-ready. Gray curbs are never recommendations. Always check posted signs.`
      : 'Facilities do not include live prices, capacity, or space availability.'}</p>
  </section>
}

function DetailHeader({ onBack }: { onBack: () => void }) {
  return <button type="button" className="back-to-results" onClick={onBack}>← Results</button>
}

function CurbDetail({ feature, now, isLoading, error, onBack }: {
  feature: ParkingViewportFeature
  now: number
  isLoading: boolean
  error: string | null
  onBack: () => void
}) {
  const remaining = countdown(feature.properties.nextChange ?? undefined, now)
  const fullFeature = isFullParkingFeature(feature) ? feature : null
  const evidence = fullFeature?.properties.evidence ?? []
  const referenceOnly = feature.properties.recommendationEligible === false || feature.properties.geometryBasis === 'official_meter_blockface'
  return <section className="detail">
    <DetailHeader onBack={onBack} />
    <span className={`status ${feature.properties.status}`}>{statusLabel(feature.properties.status)}</span>
    <h2>{feature.properties.onStreet || 'Selected curb'}</h2>
    <p>{[feature.properties.sideOfStreet ? `${feature.properties.sideOfStreet} side` : null, feature.properties.fromStreet, feature.properties.toStreet].filter(Boolean).join(' · ')}</p>
    <p>{feature.properties.ruleSummary}</p>
    {referenceOnly && <p className="curb-reference-notice" role="note">
      <b>Reference only—not a recommendation.</b>{' '}
      {feature.properties.geometryBasis === 'official_meter_blockface'
          ? feature.properties.status === 'free'
          ? 'Green is an assumed legally free curb reference for the selected interval because the linked current sign records and meter schedule were fully recognized. It does not indicate whether a physical space is vacant.'
          : 'This official meter blockface helps locate parking regulation evidence, but it is not DOT-approved curb-side geometry.'
        : 'This curb does not currently pass every geometry, evidence, freshness, and rule-coverage gate.'}
    </p>}
    {remaining && <div className="countdown"><span>Status changes in</span><strong>{remaining}</strong></div>}
    {isLoading && <p className="curb-detail-loading" role="status">Loading full rule evidence…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {fullFeature && <dl className="evidence-list">
      <div><dt>Coverage</dt><dd>{feature.properties.coverage}</dd></div>
      <div><dt>Source updated</dt><dd>{fullFeature.properties.sourceUpdatedAt ? new Date(fullFeature.properties.sourceUpdatedAt).toLocaleString() : 'Not available'}</dd></div>
      <div><dt>Interpretation</dt><dd>{fullFeature.properties.interpretationVersion}</dd></div>
    </dl>}
    {evidence.length > 0 && <section className="curb-evidence" aria-label="Classification evidence">
      <b>Why this status</b>
      <ul>{evidence.slice(0, 3).map((item, index) => <li key={`${item.source}-${index}`}>
        <span>{item.reason}</span><small>{item.source}</small>
      </li>)}</ul>
    </section>}
    <small>Confidence {Math.round(feature.properties.confidence * 100)}% • Check every posted sign before parking.</small>
  </section>
}

function GarageDetail({ garage, onBack }: { garage: Garage; onBack: () => void }) {
  return <section className="detail garage-detail">
    <DetailHeader onBack={onBack} />
    <span className="status">Active DCWP license</span>
    <h2>{garage.name}</h2>
    {garage.dbaName && garage.legalName !== garage.dbaName && <p>Legal name: {garage.legalName}</p>}
    <p>{garage.address}</p>
    <p>License {garage.licenseNumber}{garage.licenseExpiresAt ? ` · expires ${new Date(garage.licenseExpiresAt).toLocaleDateString()}` : ''}</p>
    {garage.facilityDetails && <p>{garage.facilityDetails}</p>}
    {garage.phone && <a href={`tel:${garage.phone}`}>{garage.phone}</a>}
    <small>Directory record only. Pricing, capacity, and space availability are not provided.</small>
  </section>
}

function RecommendationDetail({ option, plan, now, onBack }: { option: Recommendation; plan: ParkingPlan; now: number; onBack: () => void }) {
  const nextChange = countdown(option.nextChange ?? undefined, now)
  return <section className="detail recommendation-detail">
    <DetailHeader onBack={onBack} />
    {plan.recommendations[0]?.id === option.id && <span className="best-lead-label">Best parking lead</span>}
    <span className={`status ${option.status}`}>{option.kind === 'curb' ? statusLabel(option.status) : 'Active licensed facility'}</span>
    <h2>{option.title}</h2>
    <div className="recommendation-stay"><span>Planned parking window</span><strong>{plannedParkingWindow(plan)}</strong></div>
    {nextChange && <div className="countdown"><span>Rule changes in</span><strong>{nextChange}</strong></div>}
    <p>{option.subtitle}</p>
    <div className="recommendation-facts"><b>{option.walkMinutes} min walk</b><span>{option.distanceMeters} m away</span></div>
    <p>{option.ruleSummary}</p>
    {option.guidanceLevel === 'public_data_reference' && <p className="curb-reference-notice" role="note">
      <b>Assumed legal curb status, not live occupancy.</b> Pidge ranked this blockface because its current NYC meter and sign evidence supports the selected interval. Confirm every posted sign, curb condition, hydrant clearance, and meter before parking.
    </p>}
    {option.facility && <p>DCWP license {option.facility.licenseNumber} · {option.facility.licenseStatus}</p>}
    <small>Advisory guidance only. Check posted signs, facility terms, and current conditions.</small>
  </section>
}
