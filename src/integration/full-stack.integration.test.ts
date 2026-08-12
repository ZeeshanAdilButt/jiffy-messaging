import { once } from 'node:events'
import { createServer as createHttpServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { InProcessMessageBus } from '../adapters/in-process/index.js'
import { PostgresConversationStore, PostgresMessageStore } from '../adapters/postgres/index.js'
import { createHttpApp } from '../http/index.js'
import type { TokenVerifier, VerifiedIdentity } from '../ports/index.js'
import { attachWebSocketServer } from '../websocket/index.js'

// The only suite that talks to a real Postgres. Everything else either
// exercises the core against the in-memory adapter or one adapter against
// a fake driver; this runs the real storage, HTTP, and WebSocket layers
// together, wired the way createServer wires them.
//
// Run with `make test-integration`. Excluded from the default test run so
// that stays fast and infra-free; CI provides a Postgres service
// container for it.
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required for the integration suite. Run against a real Postgres, e.g. via ' +
      '`docker compose up postgres` and DATABASE_URL=postgres://jiffy:jiffy@localhost:5432/jiffy_messaging.',
  )
}

class FixedTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedIdentity> {
    if (token === 'user_a' || token === 'user_b') {
      return { userId: token }
    }
    throw new Error('unknown token')
  }
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const schemaSql = readFileSync(join(currentDir, '../adapters/postgres/schema.sql'), 'utf8')

describe('full stack integration', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  let server: Server
  let port: number

  beforeAll(async () => {
    await pool.query(schemaSql)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE conversation_participants, messages, conversations RESTART IDENTITY CASCADE')

    const conversations = new PostgresConversationStore(pool)
    const messages = new PostgresMessageStore(pool)
    const messageBus = new InProcessMessageBus()
    const tokenVerifier = new FixedTokenVerifier()

    const app = createHttpApp({ conversations, messages, tokenVerifier, messageBus })
    server = createHttpServer(app)
    attachWebSocketServer({ server, tokenVerifier, conversations, messageBus })

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('expected an AddressInfo')
    }
    port = address.port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('creates a conversation over REST, backed by a real Postgres row', async () => {
    const res = await request(server)
      .post('/conversations')
      .set('Authorization', 'Bearer user_a')
      .send({ participantIds: ['user_a', 'user_b'] })

    expect(res.status).toBe(201)

    const row = await pool.query('SELECT id FROM conversations WHERE id = $1', [res.body.id])
    expect(row.rowCount).toBe(1)
  })

  it('sends a message over REST and delivers it live to a WebSocket client', async () => {
    const createRes = await request(server)
      .post('/conversations')
      .set('Authorization', 'Bearer user_a')
      .send({ participantIds: ['user_a', 'user_b'] })
    const conversationId = createRes.body.id as string

    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=user_b`)
    await once(socket, 'open')

    const messagePromise = once(socket, 'message')
    const sendRes = await request(server)
      .post(`/conversations/${conversationId}/messages`)
      .set('Authorization', 'Bearer user_a')
      .send({ body: 'hello from the integration suite' })
    expect(sendRes.status).toBe(201)

    const [data] = await messagePromise
    const delivered = JSON.parse(String(data))
    expect(delivered).toMatchObject({ id: sendRes.body.id, body: 'hello from the integration suite' })

    socket.close()
  })

  it('persists messages across separate requests in real Postgres, in order', async () => {
    const createRes = await request(server)
      .post('/conversations')
      .set('Authorization', 'Bearer user_a')
      .send({ participantIds: ['user_a', 'user_b'] })
    const conversationId = createRes.body.id as string

    await request(server)
      .post(`/conversations/${conversationId}/messages`)
      .set('Authorization', 'Bearer user_a')
      .send({ body: 'first' })
    await request(server)
      .post(`/conversations/${conversationId}/messages`)
      .set('Authorization', 'Bearer user_b')
      .send({ body: 'second' })

    const listRes = await request(server)
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', 'Bearer user_a')

    expect(listRes.status).toBe(200)
    expect(listRes.body.map((m: { body: string }) => m.body)).toEqual(['first', 'second'])
  })

  it('marks a conversation read and persists it in real Postgres', async () => {
    const createRes = await request(server)
      .post('/conversations')
      .set('Authorization', 'Bearer user_a')
      .send({ participantIds: ['user_a', 'user_b'] })
    const conversationId = createRes.body.id as string

    const readRes = await request(server)
      .post(`/conversations/${conversationId}/read`)
      .set('Authorization', 'Bearer user_a')
    expect(readRes.status).toBe(204)

    const row = await pool.query(
      'SELECT last_read_at FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, 'user_a'],
    )
    expect(row.rows[0].last_read_at).not.toBeNull()
  })

  it('rejects a sender who is not a participant, checked against real Postgres data', async () => {
    const createRes = await request(server)
      .post('/conversations')
      .set('Authorization', 'Bearer user_a')
      .send({ participantIds: ['user_a'] })
    const conversationId = createRes.body.id as string

    const res = await request(server)
      .post(`/conversations/${conversationId}/messages`)
      .set('Authorization', 'Bearer user_b')
      .send({ body: 'should be rejected' })

    expect(res.status).toBe(403)
  })
})
