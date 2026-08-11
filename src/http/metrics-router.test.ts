import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createMetricsRouter } from './metrics-router.js'

describe('GET /metrics', () => {
  it('serves Prometheus-format metrics', async () => {
    const app = express()
    app.use(createMetricsRouter())

    const res = await request(app).get('/metrics')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.text).toContain('# HELP')
  })
})
