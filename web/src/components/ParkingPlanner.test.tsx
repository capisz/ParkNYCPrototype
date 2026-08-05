import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Place } from '../types'
import ParkingPlanner from './ParkingPlanner'

const api = vi.hoisted(() => ({
  autocomplete: vi.fn(),
  search: vi.fn(),
  plan: vi.fn(),
}))

vi.mock('../api', () => ({
  autocompleteDestination: api.autocomplete,
  searchDestination: api.search,
  fetchPlan: api.plan,
  defaultArrivalInput: () => '2026-07-17T18:00',
  defaultDepartureInput: () => '2026-07-17T20:00',
  planningInterval: () => ({ start: '2026-07-17T22:00:00.000Z', end: '2026-07-18T00:00:00.000Z' }),
}))

const places: Place[] = [
  { properties: { label: 'EMPIRE STATE BUILDING, New York, NY' }, geometry: { coordinates: [-73.9857, 40.7484] } },
  { properties: { label: 'EMPIRE DINER, New York, NY' }, geometry: { coordinates: [-74.0018, 40.7474] } },
]

describe('parking planner', () => {
  beforeEach(() => {
    api.autocomplete.mockReset().mockResolvedValue(places)
    api.search.mockReset().mockResolvedValue(places[0])
    api.plan.mockReset().mockResolvedValue({
      availability: { free: 2, paid: 3, cannotPark: 4, unknown: 5 },
      options: [], warnings: [], disclaimer: 'Check posted signs.',
    })
  })

  it('starts with the destination question and no authentication gate', () => {
    render(<ParkingPlanner initialPlan={null} onPlan={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Where are you going?' })).toBeTruthy()
    expect(screen.queryByText('Continue as guest')).toBeNull()
  })

  it('supports keyboard navigation across destination suggestions', async () => {
    const user = userEvent.setup()
    render(<ParkingPlanner initialPlan={null} onPlan={vi.fn()} />)
    const destination = screen.getByRole('combobox', { name: 'Destination' })
    await user.type(destination, 'Empire')
    await waitFor(() => expect(api.autocomplete).toHaveBeenCalled())
    await screen.findByRole('option', { name: places[1].properties.label })
    await user.keyboard('{ArrowDown}{Enter}')
    expect((destination as HTMLInputElement).value).toBe(places[1].properties.label)
    expect(destination.getAttribute('aria-expanded')).toBe('false')
  })

  it('submits a required interval and parking preferences', async () => {
    const user = userEvent.setup()
    const onPlan = vi.fn()
    render(<ParkingPlanner initialPlan={null} onPlan={onPlan} />)
    const destination = screen.getByRole('combobox', { name: 'Destination' })
    await user.type(destination, 'Empire')
    await waitFor(() => expect(api.autocomplete).toHaveBeenCalled())
    await user.click(await screen.findByRole('option', { name: places[0].properties.label }))
    await user.click(screen.getByRole('button', { name: 'Paid curb parking' }))
    await user.click(screen.getByRole('button', { name: 'Find parking options' }))

    await waitFor(() => expect(onPlan).toHaveBeenCalledOnce())
    expect(api.plan).toHaveBeenCalledWith(
      places[0],
      null,
      { start: '2026-07-17T22:00:00.000Z', end: '2026-07-18T00:00:00.000Z' },
      {
        allowPaid: false, allowGarages: true, maxWalkMinutes: 10, allowTransit: false,
        accessibleOnly: false, transitModes: ['SUBWAY', 'BUS', 'SIR', 'LIRR', 'METRO_NORTH'],
      },
    )
  })

  it('states that current guidance is unavailable while offline', () => {
    render(<ParkingPlanner initialPlan={null} isOnline={false} onPlan={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('planner will try the current sources')
  })

  it('shows autocomplete outages and still resolves typed text on submit', async () => {
    const user = userEvent.setup()
    const onPlan = vi.fn()
    api.autocomplete.mockRejectedValueOnce(new Error('temporary outage'))
    render(<ParkingPlanner initialPlan={null} onPlan={onPlan} />)

    await user.type(screen.getByRole('combobox', { name: 'Destination' }), 'Central Park')
    expect((await screen.findByRole('alert')).textContent).toContain('suggestions are temporarily unavailable')

    const submit = screen.getByRole('button', { name: 'Find parking options' })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    await user.click(submit)

    await waitFor(() => expect(api.search).toHaveBeenCalledWith('Central Park'))
    await waitFor(() => expect(onPlan).toHaveBeenCalledOnce())
    expect(api.plan).toHaveBeenCalledWith(
      places[0],
      null,
      { start: '2026-07-17T22:00:00.000Z', end: '2026-07-18T00:00:00.000Z' },
      expect.objectContaining({ allowTransit: false }),
    )
  })

  it('does not block a typed destination only because the browser reports offline', async () => {
    const user = userEvent.setup()
    render(<ParkingPlanner initialPlan={null} isOnline={false} onPlan={vi.fn()} />)
    await user.type(screen.getByRole('combobox', { name: 'Destination' }), 'Central Park')
    expect((screen.getByRole('button', { name: 'Find parking options' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
