import { describe, expect, it } from 'vitest'
import { countdown } from './countdown'

describe('parking countdown', () => {
  it('formats remaining time as minutes and seconds', () => {
    expect(countdown('2026-07-17T00:02:05.000Z', Date.parse('2026-07-17T00:00:00.000Z'))).toBe('02:05')
  })

  it('only appears during the hour before a future change', () => {
    expect(countdown('2026-07-16T23:59:00.000Z', Date.parse('2026-07-17T00:00:00.000Z'))).toBeNull()
    expect(countdown('2026-07-17T01:00:01.000Z', Date.parse('2026-07-17T00:00:00.000Z'))).toBeNull()
    expect(countdown('not-a-date', Date.parse('2026-07-17T00:00:00.000Z'))).toBeNull()
    expect(countdown()).toBeNull()
  })
})
