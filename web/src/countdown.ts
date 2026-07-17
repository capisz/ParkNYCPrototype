export function countdown(target?: string, now = Date.now()): string | null {
  if (!target) return null
  const remaining = Math.max(0, new Date(target).getTime() - now)
  if (remaining <= 0) return '00:00'
  const total = Math.floor(remaining / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
