import { Router } from 'express'

export interface HealthRouterConfig {
  /** Returns true when this instance can actually serve traffic. Defaults to always ready. */
  readinessCheck?: () => Promise<boolean>
}

export function createHealthRouter(config: HealthRouterConfig = {}): Router {
  const router = Router()

  // Liveness: the process is running and responding to HTTP, nothing
  // more. No dependency checks here - a database that is slow or briefly
  // down should not make Kubernetes kill and restart a pod that would
  // have recovered on its own once the database did.
  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  // Readiness: this instance can serve requests right now. A pod that
  // fails this stops receiving traffic without being restarted, which is
  // the right response to a transient dependency problem rather than a
  // crash loop.
  router.get('/ready', async (_req, res) => {
    let ready: boolean
    try {
      ready = config.readinessCheck ? await config.readinessCheck() : true
    } catch {
      ready = false
    }
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready' })
  })

  return router
}
