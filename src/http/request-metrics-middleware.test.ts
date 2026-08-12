import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { register } from '../observability/metrics.js'
import { createRequestMetricsMiddleware } from './request-metrics-middleware.js'

describe('createRequestMetricsMiddleware', () => {
  it('records a request against the matched route pattern, not the literal path', async () => {
    const app = express()
    app.use(createRequestMetricsMiddleware())
    app.get('/widgets/:id', (_req, res) => res.status(200).end())

    await request(app).get('/widgets/abc123')

    const metric = await register.getSingleMetricAsString('jiffy_messaging_http_requests_total')
    expect(metric).toContain('route="/widgets/:id"')
    expect(metric).not.toContain('abc123')
  })

  it('labels the status code the response actually sent', async () => {
    const app = express()
    app.use(createRequestMetricsMiddleware())
    app.get('/boom', (_req, res) => res.status(500).end())

    await request(app).get('/boom')

    const metric = await register.getSingleMetricAsString('jiffy_messaging_http_requests_total')
    expect(metric).toContain('status="500"')
  })

  it('labels a request that matches no route as "unmatched" rather than the raw path', async () => {
    const app = express()
    app.use(createRequestMetricsMiddleware())
    // No routes registered at all, so this 404s without ever setting
    // req.route - the same shape a probe hitting a made-up path produces.

    await request(app).get('/conversations/33333333-3333-4333-8333-333333333333/messages')

    const metric = await register.getSingleMetricAsString('jiffy_messaging_http_requests_total')
    expect(metric).toContain('route="unmatched"')
    expect(metric).not.toContain('33333333-3333-4333-8333-333333333333')
  })

  it('labels a request blocked before it reaches any route as "unmatched"', async () => {
    // Stands in for an expired-token 401: middleware ahead of the router
    // sends a response and never calls next() into a matching route, so
    // req.route is never set even though the path itself is
    // route-shaped and would carry a real conversation id in production.
    const app = express()
    app.use(createRequestMetricsMiddleware())
    app.use((_req, res) => {
      res.status(401).json({ error: 'Invalid or expired token' })
    })
    app.get('/conversations/:id/messages', (_req, res) => res.status(200).end())

    await request(app).get('/conversations/real-conversation-id/messages')

    const metric = await register.getSingleMetricAsString('jiffy_messaging_http_requests_total')
    expect(metric).toContain('route="unmatched"')
    expect(metric).not.toContain('real-conversation-id')
  })
})
