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
      // not do.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path
      const labels = { method: req.method, route, status: String(res.statusCode) }
      httpRequestsTotal.inc(labels)
      endTimer(labels)
    })

    next()
  }
}
