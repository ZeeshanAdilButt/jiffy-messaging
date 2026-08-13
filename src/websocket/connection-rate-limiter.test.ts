import { describe, expect, it } from 'vitest'

import { ConnectionRateLimiter } from './connection-rate-limiter.js'

describe('ConnectionRateLimiter', () => {
  it('allows attempts up to the limit within a window', () => {
    const limiter = new ConnectionRateLimiter(2, 60_000)
    expect(limiter.allow('1.2.3.4', 0)).toBe(true)
    expect(limiter.allow('1.2.3.4', 1)).toBe(true)
  })

  it('rejects an attempt past the limit within the same window', () => {
    const limiter = new ConnectionRateLimiter(2, 60_000)
    limiter.allow('1.2.3.4', 0)
    limiter.allow('1.2.3.4', 1)
    expect(limiter.allow('1.2.3.4', 2)).toBe(false)
  })

  it('resets once the window has elapsed', () => {
    const limiter = new ConnectionRateLimiter(1, 1000)
    limiter.allow('1.2.3.4', 0)
    expect(limiter.allow('1.2.3.4', 500)).toBe(false)
    expect(limiter.allow('1.2.3.4', 1000)).toBe(true)
  })

  it('tracks separate budgets per key', () => {
    const limiter = new ConnectionRateLimiter(1, 60_000)
    expect(limiter.allow('1.2.3.4', 0)).toBe(true)
    expect(limiter.allow('5.6.7.8', 0)).toBe(true)
  })

  describe('sweep', () => {
    it('drops a window once it is no longer current', () => {
      const limiter = new ConnectionRateLimiter(2, 1000)
      limiter.allow('1.2.3.4', 0)
      expect(limiter.size).toBe(1)

      limiter.sweep(1000)
      expect(limiter.size).toBe(0)

      limiter.stop()
    })

    it('leaves a window in place while it is still current', () => {
      const limiter = new ConnectionRateLimiter(2, 1000)
      limiter.allow('1.2.3.4', 0)

      limiter.sweep(500)
      expect(limiter.size).toBe(1)

      limiter.stop()
    })

    it('does not grow without bound as distinct keys come and go', () => {
      const limiter = new ConnectionRateLimiter(2, 1000)
      for (let i = 0; i < 1000; i++) {
        limiter.allow(`10.0.0.${i}`, 0)
      }
      expect(limiter.size).toBe(1000)

      limiter.sweep(1000)
      expect(limiter.size).toBe(0)

      limiter.stop()
    })
  })
})
