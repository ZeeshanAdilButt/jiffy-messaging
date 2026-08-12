import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit'

// Both limiters are in-memory, so each running instance enforces its own
// count rather than one shared across every instance behind a load
// balancer. The effective limit per client is therefore (configured
// limit) x (instance count). That still protects any single instance from
// being overwhelmed; a global limit would need a shared store.

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
