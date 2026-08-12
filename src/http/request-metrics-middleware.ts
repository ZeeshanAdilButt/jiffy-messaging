import type { NextFunction, Request, Response } from 'express'

import { httpRequestDuration, httpRequestsTotal } from '../observability/metrics.js'

export function createRequestMetricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const endTimer = httpRequestDuration.startTimer()

    res.on('finish', () => {
      // req.route.path is only set once Express has matched a specific
      // route, e.g. "/conversations/:id" rather than the literal id - a
      // label per literal path would mean a new time series per
      // conversation id, which is exactly what a metrics label should
      // not do. Falling back to the literal req.path here has the same
      // problem twice over: 404 or probe spam creates one label per
      // distinct path an attacker sends (unbounded cardinality), and a
      // request that never reaches the router at all - an expired-token
      // 401, blocked before auth even hands off to it - would fall back
      // to req.path and leak the real conversation id straight into a
      // metric label. 'unmatched' collapses every one of those into a
      // single fixed series instead.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
      const labels = { method: req.method, route, status: String(res.statusCode) }
      httpRequestsTotal.inc(labels)
      endTimer(labels)
    })

    next()
  }
}
