import { describe, expect, it } from 'vitest'
import { defaultArrivalInput, defaultDepartureInput, planningInterval } from './api'

describe('interval planning', () => {
  it('rounds the default arrival to a future quarter hour', () => {
    expect(defaultArrivalInput(new Date('2026-07-17T12:07:00-04:00'))).toBe('2026-07-17T12:30')
  })

  it('defaults departure to two hours after arrival', () => {
    expect(defaultDepartureInput('2026-07-17T18:00')).toBe('2026-07-17T20:00')
  })

  it('freezes valid local inputs into an interval', () => {
    const value = planningInterval(
      '2026-07-17T18:00', '2026-07-17T20:00',
      new Date('2026-07-17T12:00:00-04:00'),
    )
    expect(new Date(value.start).getTime()).toBe(new Date('2026-07-17T18:00').getTime())
    expect(new Date(value.end).getTime()).toBe(new Date('2026-07-17T20:00').getTime())
  })

  it('rejects missing, reversed, and out-of-range intervals', () => {
    const now = new Date('2026-07-17T12:00:00-04:00')
    expect(() => planningInterval('', '2026-07-17T20:00', now)).toThrow('arrive')
    expect(() => planningInterval('2026-07-17T20:00', '2026-07-17T18:00', now)).toThrow('after')
    expect(() => planningInterval('2026-07-15T12:00', '2026-07-15T14:00', now)).toThrow('past')
    expect(() => planningInterval('2026-09-17T12:00', '2026-09-17T14:00', now)).toThrow('30 days')
  })
})
