export function countdown(target?: string, now = Date.now()): string | null {
  if (!target) return null
  const remaining = new Date(target).getTime() - now
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 60 * 60 * 1000) return null
  const total = Math.floor(remaining / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
