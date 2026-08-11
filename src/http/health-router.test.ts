import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createHealthRouter } from './health-router.js'

function appWith(readinessCheck?: () => Promise<boolean>) {
  const app = express()
  app.use(createHealthRouter({ readinessCheck }))
  return app
}

describe('GET /health', () => {
  it('always returns 200, with no readiness check configured', async () => {
    const res = await request(appWith()).get('/health')
    expect(res.status).toBe(200)
  })
})

describe('GET /ready', () => {
  it('returns 200 when no readiness check is configured', async () => {
    const res = await request(appWith()).get('/ready')
    expect(res.status).toBe(200)
  })

  it('returns 200 when the readiness check resolves true', async () => {
    const res = await request(appWith(async () => true)).get('/ready')
    expect(res.status).toBe(200)
  })

  it('returns 503 when the readiness check resolves false', async () => {
    const res = await request(appWith(async () => false)).get('/ready')
    expect(res.status).toBe(503)
  })

  it('returns 503 when the readiness check rejects', async () => {
    const res = await request(
      appWith(async () => {
        throw new Error('database unreachable')
      }),
    ).get('/ready')
    expect(res.status).toBe(503)
  })
})
