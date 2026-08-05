import { afterEach, describe, expect, it, vi } from 'vitest'
import { DebouncedViewportRefresh } from './viewportRefresh'

describe('DebouncedViewportRefresh', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces rapid map movements and supersedes stale work immediately', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const supersede = vi.fn()
    const scheduler = new DebouncedViewportRefresh(refresh, supersede, 320)

    scheduler.schedule()
    vi.advanceTimersByTime(200)
    scheduler.schedule()
    vi.advanceTimersByTime(319)

    expect(supersede).toHaveBeenCalledTimes(2)
    expect(refresh).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('cancels a queued refresh during map cleanup', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const supersede = vi.fn()
    const scheduler = new DebouncedViewportRefresh(refresh, supersede, 320)

    scheduler.schedule()
    scheduler.cancel()
    vi.runAllTimers()

    expect(refresh).not.toHaveBeenCalled()
    expect(supersede).toHaveBeenCalledTimes(2)
  })
})
