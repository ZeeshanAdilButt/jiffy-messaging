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
})
