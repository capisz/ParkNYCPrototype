import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LoadingOverlay from './LoadingOverlay'

describe('loading overlay', () => {
  afterEach(() => vi.useRealTimers())

  it('waits briefly to avoid flashing during fast requests, then announces progress', () => {
    vi.useFakeTimers()
    render(<LoadingOverlay title="Loading nearby curb guidance" detail="Checking parking evidence." delayMs={180} />)
    expect(screen.queryByTestId('loading-overlay')).toBeNull()

    act(() => vi.advanceTimersByTime(180))

    expect(screen.getByTestId('loading-overlay').getAttribute('aria-label')).toBe('Loading nearby curb guidance')
    expect(screen.getByText('Checking parking evidence.')).toBeTruthy()
  })
})
