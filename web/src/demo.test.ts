import { describe, expect, it } from 'vitest'
import { demoRequest } from './demo'
import type { RecommendationPayload } from './types'

describe('standalone demo', () => {
  it('searches only the sample destinations', async () => {
    expect(await demoRequest('/api/v1/search?text=Bryant')).toMatchObject({ features: [{ properties: { label: 'Bryant Park, Manhattan' } }] })
    expect(await demoRequest('/api/v1/search?text=unlisted')).toEqual({ features: [] })
  })
  it('honors paid and accessibility preferences without claiming accessible sample parking', async () => {
    const request = (accessibleOnly: boolean) => demoRequest('/api/v1/plans', { body: JSON.stringify({
      destination: { longitude: -73.9857, latitude: 40.7484 }, arriveBy: '2026-09-12T12:00:00Z', leaveAt: '2026-09-12T14:00:00Z',
      preferences: { allowPaid: false, accessibleOnly, maxWalkMinutes: 10, includeGarages: true },
    }) }) as Promise<RecommendationPayload>
    const plan = await request(false)
    expect(plan.options.map(option => option.status)).toEqual(['free'])
    expect(plan.disclaimer).toContain('fictional')
    expect((await request(true)).options).toEqual([])
  })
  it('respects cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(demoRequest('/api/v1/search?text=Bryant', { signal: controller.signal })).rejects.toThrow()
  })
})
