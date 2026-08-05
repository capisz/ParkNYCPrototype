import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ParkingPlan, SheetSnap } from '../types'
import AdaptiveMapSheet from './AdaptiveMapSheet'

const plan: ParkingPlan = {
  place: { properties: { label: 'Empire State Building' }, geometry: { coordinates: [-73.9857, 40.7484] } },
  origin: null,
  label: 'Empire State Building',
  originLabel: '',
  arrivalInput: '2026-07-17T18:00',
  departureInput: '2026-07-17T20:00',
  arrivalIso: '2026-07-17T22:00:00.000Z',
  departureIso: '2026-07-18T00:00:00.000Z',
  preferences: {
    allowPaid: true, allowGarages: true, maxWalkMinutes: 10, allowTransit: false,
    accessibleOnly: false, transitModes: ['SUBWAY', 'BUS', 'SIR', 'LIRR', 'METRO_NORTH'],
  },
  availability: { free: 2, paid: 3, cannotPark: 5, unknown: 4 },
  recommendations: [{
    id: 'rec-1', kind: 'curb', tier: 'free', status: 'free', title: 'West 34 Street', subtitle: '5 Ave to 6 Ave',
    latitude: 40.748, longitude: -73.986, distanceMeters: 120, walkMinutes: 2, confidence: 0.9,
    coverage: 'full', score: 9, ruleSummary: 'Free for the complete selected stay.', nextChange: null,
    sourceVersion: 'test', facility: null, transit: null,
  }],
  warnings: [],
  disclaimer: 'Check posted signs.',
}

function Harness() {
  const [snap, setSnap] = useState<SheetSnap>('half')
  return <AdaptiveMapSheet
    plan={plan}
    mode="best"
    snap={snap}
    availability={plan.availability}
    parking={[]}
    garages={[]}
    selectedCurb={null}
    selectedGarage={null}
    selectedRecommendation={null}
    message="Parking sources loaded"
    error={null}
    isLoading={false}
    isRefreshing={false}
    isOnline
    lastUpdated={new Date('2026-07-17T22:00:00Z')}
    now={Date.parse('2026-07-17T22:00:00Z')}
    onModeChange={vi.fn()}
    onSnapChange={setSnap}
    onChangePlan={vi.fn()}
    onRecenter={vi.fn()}
    onRetry={vi.fn()}
    onClearSelection={vi.fn()}
    onSelectCurb={vi.fn()}
    onSelectGarage={vi.fn()}
    onSelectRecommendation={vi.fn()}
  />
}

describe('adaptive map sheet', () => {
  it('shows the best parking lead and exact planned parking window when selected', () => {
    render(<AdaptiveMapSheet
      plan={plan}
      mode="best"
      snap="half"
      availability={plan.availability}
      parking={[]}
      garages={[]}
      selectedCurb={null}
      selectedGarage={null}
      selectedRecommendation={plan.recommendations[0]}
      message="Parking sources loaded"
      error={null}
      isLoading={false}
      isRefreshing={false}
      isOnline
      lastUpdated={new Date('2026-07-17T22:00:00Z')}
      now={Date.parse('2026-07-17T22:00:00Z')}
      onModeChange={vi.fn()}
      onSnapChange={vi.fn()}
      onChangePlan={vi.fn()}
      onRecenter={vi.fn()}
      onRetry={vi.fn()}
      onClearSelection={vi.fn()}
      onSelectCurb={vi.fn()}
      onSelectGarage={vi.fn()}
      onSelectRecommendation={vi.fn()}
    />)

    expect(screen.getByText('Best parking lead')).toBeTruthy()
    expect(screen.getByText('Planned parking window')).toBeTruthy()
    expect(screen.getByText('Jul 17, 6:00 PM–8:00 PM')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Center map on best parking lead' }).length).toBeGreaterThan(0)
  })

  it('shows explicit option state, exact legend semantics, red totals, and snap controls', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.getByRole('button', { name: 'Options' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Parking options' })).toBeTruthy()
    expect(screen.getByText('Red means cannot park')).toBeTruthy()
    expect(screen.getByText('Yellow means paid parking')).toBeTruthy()
    expect(screen.getByText('Green means likely free · verify signs')).toBeTruthy()
    expect(screen.getByText('Gray means unknown — check signs')).toBeTruthy()
    expect(screen.getByText('1 likely free')).toBeTruthy()
    expect(screen.queryByText('5 cannot park')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Minimize parking panel' }))
    expect(screen.getByRole('button', { name: 'Open parking panel' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open parking panel' }))
    expect(screen.getByRole('heading', { name: 'Parking options' })).toBeTruthy()
  })

  it('explains unresolved coverage and opens curb references without claiming parking', async () => {
    const user = userEvent.setup()
    const onModeChange = vi.fn()
    const unresolvedPlan = {
      ...plan,
      availability: { free: 0, paid: 0, cannotPark: 0, unknown: 4 },
      recommendations: [],
      warnings: [{ code: 'curb_guidance_unknown', message: 'Nearby curb evidence is unresolved.' }],
    }
    render(<AdaptiveMapSheet
      plan={unresolvedPlan}
      mode="best"
      snap="half"
      availability={unresolvedPlan.availability}
      parking={[]}
      garages={[]}
      selectedCurb={null}
      selectedGarage={null}
      selectedRecommendation={null}
      message="Parking sources loaded"
      error={null}
      isLoading={false}
      isRefreshing={false}
      isOnline
      lastUpdated={new Date('2026-07-17T22:00:00Z')}
      now={Date.parse('2026-07-17T22:00:00Z')}
      onModeChange={onModeChange}
      onSnapChange={vi.fn()}
      onChangePlan={vi.fn()}
      onRecenter={vi.fn()}
      onRetry={vi.fn()}
      onClearSelection={vi.fn()}
      onSelectCurb={vi.fn()}
      onSelectGarage={vi.fn()}
      onSelectRecommendation={vi.fn()}
    />)

    expect(screen.getByText('No supported likely-free or paid options yet')).toBeTruthy()
    expect(screen.getByText('0 ranked curb leads')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Review all 4 curb references' }))
    expect(onModeChange).toHaveBeenCalledWith('street')
  })

  it('marks a colored meter blockface as reference-only rather than a recommendation', () => {
    render(<AdaptiveMapSheet
      plan={plan}
      mode="street"
      snap="half"
      availability={{ free: 0, paid: 1, cannotPark: 0, unknown: 0 }}
      parking={[]}
      garages={[]}
      selectedCurb={{
        type: 'Feature',
        id: 'meter-reference',
        geometry: { type: 'LineString', coordinates: [[-73.986, 40.748], [-73.985, 40.748]] },
        properties: {
          status: 'paid',
          color: '#f2c14e',
          confidence: 0.92,
          coverage: 'full',
          geometryValidated: true,
          geometryBasis: 'official_meter_blockface',
          recommendationEligible: false,
          ruleSummary: 'Yellow means paid parking during this interval.',
          nextChange: null,
          onStreet: '5 Avenue',
          sideOfStreet: 'East',
        },
      }}
      selectedGarage={null}
      selectedRecommendation={null}
      message="Parking sources loaded"
      error={null}
      isLoading={false}
      isRefreshing={false}
      isOnline
      lastUpdated={new Date('2026-07-17T22:00:00Z')}
      now={Date.parse('2026-07-17T22:00:00Z')}
      onModeChange={vi.fn()}
      onSnapChange={vi.fn()}
      onChangePlan={vi.fn()}
      onRecenter={vi.fn()}
      onRetry={vi.fn()}
      onClearSelection={vi.fn()}
      onSelectCurb={vi.fn()}
      onSelectGarage={vi.fn()}
      onSelectRecommendation={vi.fn()}
    />)

    expect(screen.getByText('Reference only—not a recommendation.')).toBeTruthy()
    expect(screen.getByText(/not DOT-approved curb-side geometry/)).toBeTruthy()
  })

  it('explains that reference green is a public-data estimate, not availability', () => {
    render(<AdaptiveMapSheet
      plan={plan}
      mode="street"
      snap="half"
      availability={{ free: 1, paid: 0, cannotPark: 0, unknown: 0 }}
      parking={[]}
      garages={[]}
      selectedCurb={{
        type: 'Feature',
        id: 'green-meter-reference',
        geometry: { type: 'LineString', coordinates: [[-73.986, 40.748], [-73.985, 40.748]] },
        properties: {
          status: 'free', color: '#238b45', confidence: 0.65, coverage: 'full',
          geometryValidated: false, geometryBasis: 'official_meter_blockface', recommendationEligible: false,
          ruleSummary: 'Green means likely free parking for the complete planned interval; verify posted signs.', nextChange: null,
          onStreet: '5 Avenue', sideOfStreet: 'East',
        },
      }}
      selectedGarage={null}
      selectedRecommendation={null}
      message="Parking sources loaded"
      error={null}
      isLoading={false}
      isRefreshing={false}
      isOnline
      lastUpdated={new Date('2026-07-17T22:00:00Z')}
      now={Date.parse('2026-07-17T22:00:00Z')}
      onModeChange={vi.fn()}
      onSnapChange={vi.fn()}
      onChangePlan={vi.fn()}
      onRecenter={vi.fn()}
      onRetry={vi.fn()}
      onClearSelection={vi.fn()}
      onSelectCurb={vi.fn()}
      onSelectGarage={vi.fn()}
      onSelectRecommendation={vi.fn()}
    />)
    expect(screen.getByText(/Green is an assumed legally free curb reference/)).toBeTruthy()
    expect(screen.getByText(/does not indicate whether a physical space is vacant/i)).toBeTruthy()
  })
})
