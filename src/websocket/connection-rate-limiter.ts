/**
 * Fixed-window connection-attempt limiter keyed by source IP. This limits
 * how fast a single source can open new WebSocket connections - it has
 * nothing to do with messages on a connection already open, because this
 * layer has no inbound message channel from the client to rate limit (see
 * websocket-server.ts: the server only ever pushes). Connection attempts
 * are the whole rate-limitable surface here.
 */
export class ConnectionRateLimiter {
  private readonly windows = new Map<string, { count: number; windowStart: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

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
}
