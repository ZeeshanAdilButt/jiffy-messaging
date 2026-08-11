import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createIpRateLimiter, createUserRateLimiter } from './rate-limit.js'

describe('createIpRateLimiter', () => {
  it('allows requests up to the limit', async () => {
    const app = express()
    app.use(createIpRateLimiter({ limit: 2, windowMs: 60_000 }))
    app.get('/', (_req, res) => res.status(200).end())

    const first = await request(app).get('/')
    const second = await request(app).get('/')

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
  })

  it('rejects a request past the limit with 429', async () => {
    const app = express()
    app.use(createIpRateLimiter({ limit: 2, windowMs: 60_000 }))
    app.get('/', (_req, res) => res.status(200).end())

    await request(app).get('/')
    await request(app).get('/')
    const third = await request(app).get('/')

    expect(third.status).toBe(429)
  })
})

describe('createUserRateLimiter', () => {
  function appWithFixedUser(userId: string, limit: number) {
    const app = express()
    app.use((_req, res, next) => {
      res.locals.userId = userId
      next()
    })
    app.use(createUserRateLimiter({ limit, windowMs: 60_000 }))
    app.get('/', (_req, res) => res.status(200).end())
    return app
  }

  it('tracks separate budgets per user', async () => {
    const appA = appWithFixedUser('user_a', 1)
    const appB = appWithFixedUser('user_b', 1)

    const resA = await request(appA).get('/')
    const resB = await request(appB).get('/')

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
  })

  it('rejects a second request from the same user past a limit of one', async () => {
    const app = appWithFixedUser('user_a', 1)

    const first = await request(app).get('/')
    const second = await request(app).get('/')

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
  })
})
