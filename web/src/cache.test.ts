import { describe, expect, it } from 'vitest'
import { TimedLruCache } from './cache'

describe('viewport cache', () => {
  it('expires live entries without discarding an explicit stale fallback', () => {
    let now = 1_000
    const cache = new TimedLruCache<string>(2, 100, () => now)
    cache.set('arrival-a', 'fresh')
    expect(cache.get('arrival-a')?.value).toBe('fresh')
    now = 1_101
    expect(cache.get('arrival-a')).toBeNull()
    expect(cache.get('arrival-a', true)).toEqual({ value: 'fresh', storedAt: 1_000, stale: true })
  })

  it('bounds memory and keeps arrival-specific keys separate', () => {
    const cache = new TimedLruCache<number>(2, 1_000, () => 50)
    cache.set('area:arrival-a', 1)
    cache.set('area:arrival-b', 2)
    cache.set('other:arrival-a', 3)
    expect(cache.size).toBe(2)
    expect(cache.get('area:arrival-a', true)).toBeNull()
    expect(cache.get('area:arrival-b')?.value).toBe(2)
  })
})
