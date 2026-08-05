export class DebouncedViewportRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly refresh: () => void
  private readonly supersede: () => void
  private readonly delayMs: number

  constructor(
    refresh: () => void,
    supersede: () => void,
    delayMs: number,
  ) {
    this.refresh = refresh
    this.supersede = supersede
    this.delayMs = delayMs
  }

  schedule(): void {
    this.supersede()
    this.clearPending()
    this.timer = setTimeout(() => {
      this.timer = null
      this.refresh()
    }, this.delayMs)
  }

  clearPending(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  cancel(): void {
    this.clearPending()
    this.supersede()
  }
}
