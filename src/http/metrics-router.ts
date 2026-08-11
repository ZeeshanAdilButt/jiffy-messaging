import { Router } from 'express'

import { register } from '../observability/metrics.js'

export function createMetricsRouter(): Router {
  const router = Router()

  router.get('/metrics', async (_req, res) => {
    res.set('Content-Type', register.contentType)
    res.end(await register.metrics())
  })

  return router
}
