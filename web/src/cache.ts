export type CacheHit<T> = {
  value: T
  storedAt: number
  stale: boolean
}

type Entry<T> = { value: T; storedAt: number }

export class TimedLruCache<T> {
  private readonly values = new Map<string, Entry<T>>()
  private readonly maxEntries: number
  private readonly ttlMilliseconds: number
  private readonly now: () => number

  constructor(
    maxEntries: number,
    ttlMilliseconds: number,
    now: () => number = Date.now,
  ) {
    this.maxEntries = maxEntries
    this.ttlMilliseconds = ttlMilliseconds
    this.now = now
  }

  get(key: string, allowStale = false): CacheHit<T> | null {
    const entry = this.values.get(key)
    if (!entry) return null
    const stale = this.now() - entry.storedAt > this.ttlMilliseconds
    if (stale && !allowStale) return null
    this.values.delete(key)
    this.values.set(key, entry)
    return { ...entry, stale }
  }

  set(key: string, value: T): CacheHit<T> {
    const entry = { value, storedAt: this.now() }
    this.values.delete(key)
    this.values.set(key, entry)
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined
      if (!oldest) break
      this.values.delete(oldest)
    }
    return { ...entry, stale: false }
  }

  get size(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }
}
