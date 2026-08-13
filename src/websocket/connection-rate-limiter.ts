/**
 * Fixed-window connection-attempt limiter keyed by source IP. This limits
 * how fast a single source can open new WebSocket connections - it has
 * nothing to do with messages on a connection already open, because this
 * layer has no inbound message channel from the client to rate limit (see
 * websocket-server.ts: the server only ever pushes). Connection attempts
 * are the whole rate-limitable surface here.
 */
export interface ConnectionRateLimiterOptions {
  /** How often the background sweep runs. Defaults to windowMs. */
  sweepIntervalMs?: number
}

export class ConnectionRateLimiter {
  private readonly windows = new Map<string, { count: number; windowStart: number }>()
  private readonly sweepTimer: NodeJS.Timeout

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    options: ConnectionRateLimiterOptions = {},
  ) {
    // Nothing ever removed an entry from `windows` once its window
    // expired, so a long-running process accumulates one entry per
    // distinct source IP it has ever seen, forever. A periodic sweep
    // drops anything whose window is no longer current; unref so this
    // timer alone never keeps the process (or a test) alive.
    const sweepIntervalMs = options.sweepIntervalMs ?? windowMs
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs)
    this.sweepTimer.unref?.()
  }

  allow(key: string, now: number = Date.now()): boolean {
    const window = this.windows.get(key)

    if (!window || now - window.windowStart >= this.windowMs) {
      this.windows.set(key, { count: 1, windowStart: now })
      return true
    }

    if (window.count >= this.limit) {
      return false
    }

    window.count += 1
    return true
  }

  /**
   * Drops every window that is no longer current. Exposed as a public
   * method - not just wired to the internal timer - so a test can call it
   * directly instead of waiting on a real interval.
   */
  sweep(now: number = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (now - window.windowStart >= this.windowMs) {
        this.windows.delete(key)
      }
    }
  }

  /** Number of source IPs currently holding a window. For tests. */
  get size(): number {
    return this.windows.size
  }

  /** Stops the background sweep. Only needed for a limiter that should be discarded before process exit, e.g. in tests. */
  stop(): void {
    clearInterval(this.sweepTimer)
  }
}
