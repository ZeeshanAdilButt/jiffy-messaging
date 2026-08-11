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
})
