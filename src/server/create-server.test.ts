import { once } from 'node:events'
import type { Server } from 'node:http'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Pool } from 'pg'

import type { MessageBus, TokenVerifier, VerifiedIdentity } from '../ports/index.js'
import { createServer } from './create-server.js'

class FixedTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedIdentity> {
    if (token === 'user_a') {
      return { userId: 'user_a' }
    }
    throw new Error('unknown token')
  }
}

// A fake Pool is enough here - this test only needs to prove the HTTP and
// WebSocket layers are actually wired onto the returned server, not that
// the Postgres adapter talks to a real database. That is covered by the
// postgres adapter's own tests.
function fakePool(queryImpl: () => Promise<unknown> = async () => ({ rows: [] })): Pool {
  return {
    query: queryImpl,
    connect: async () => ({
      query: queryImpl,
      release: () => {},
    }),
  } as unknown as Pool
}

describe('createServer', () => {
  let server: Server

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('serves the HTTP layer', async () => {
    server = createServer({ pool: fakePool(), tokenVerifier: new FixedTokenVerifier() })
    const res = await request(server).get('/conversations')
    expect(res.status).toBe(401)
  })

  it('serves the WebSocket layer on the same port', async () => {
    server = createServer({ pool: fakePool(), tokenVerifier: new FixedTokenVerifier() })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('expected an AddressInfo')
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=user_a`)
    try {
      await once(socket, 'open')
      expect(socket.readyState).toBe(WebSocket.OPEN)
    } finally {
      socket.close()
    }
  })

  it('wires a supplied message bus into the WebSocket layer instead of the default', () => {
    let subscribedHandlerCount = 0
    const bus: MessageBus = {
      async publish() {},
      onMessage(_handler) {
        subscribedHandlerCount += 1
        return () => {}
      },
    }

    server = createServer({ pool: fakePool(), tokenVerifier: new FixedTokenVerifier(), messageBus: bus })

    expect(subscribedHandlerCount).toBe(1)
  })

  it('reports ready when the pool query succeeds', async () => {
    server = createServer({ pool: fakePool(), tokenVerifier: new FixedTokenVerifier() })
    const res = await request(server).get('/ready')
    expect(res.status).toBe(200)
  })

  it('reports not ready when the pool query fails', async () => {
    const failingPool = fakePool(async () => {
      throw new Error('connection refused')
    })
    server = createServer({ pool: failingPool, tokenVerifier: new FixedTokenVerifier() })
    const res = await request(server).get('/ready')
    expect(res.status).toBe(503)
  })
})
