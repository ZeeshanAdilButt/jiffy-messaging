import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit'

// Both limiters are in-memory, so each running instance enforces its own
// count rather than a count shared across every instance behind a load
// balancer. That is a real gap for a multi-instance deployment - the
// actual limit per client ends up being (configured limit) x (instance
// count) - but it still stops a single instance from being overwhelmed,
// and closing the gap needs a shared store (Redis) this phase does not
// add.

export interface RateLimitOptions {
  windowMs?: number
  limit?: number
}

/**
 * Baseline protection keyed by IP, applied before authentication runs -
 * this is what stops a flood of requests with garbage tokens from making
 * every one of them pay the cost of token verification.
 */
export function createIpRateLimiter(options: RateLimitOptions = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? 60_000,
    limit: options.limit ?? 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
}

/**
 * Per-user protection on the authenticated API surface, keyed by the
 * verified user id rather than IP - several users behind the same NAT or
 * corporate proxy should not share one budget, and one user rotating
 * source IPs should not get a fresh budget for free.
 */
export function createUserRateLimiter(options: RateLimitOptions = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? 60_000,
    limit: options.limit ?? 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (_req, res) => (res.locals.userId as string | undefined) ?? 'anonymous',
  })
}
