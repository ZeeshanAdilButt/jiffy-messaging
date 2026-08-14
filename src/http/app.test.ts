import express from 'express'
import pino from 'pino'
import { pinoHttp } from 'pino-http'
import { Writable } from 'node:stream'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Express } from 'express'

import { InMemoryConversationStore, InMemoryMessageStore } from '../adapters/in-memory/index.js'
import type { Message } from '../domain/index.js'
import type {
  ConversationGate,
  MessageBus,
  TokenVerifier,
  VerifiedIdentity,
} from '../ports/index.js'
import { createHttpApp, LOG_REDACT_PATHS } from './app.js'

// Token "user_a" verifies as user_a, "user_b" as user_b, anything else fails.
// Real verification is jose's job (see adapters/jwt); this only needs to be
// enough to exercise the auth middleware and the routes behind it.
const KNOWN_USERS = ['user_a', 'user_b', 'user_c'] as const
type KnownUser = (typeof KNOWN_USERS)[number]

class FixedTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedIdentity> {
    if ((KNOWN_USERS as readonly string[]).includes(token)) {
      return { userId: token }
    }
    throw new Error('unknown token')
  }
}

function authed(app: Express, method: 'get' | 'post', path: string, userId: KnownUser) {
  return request(app)[method](path).set('Authorization', `Bearer ${userId}`)
}

describe('HTTP app', () => {
  let app: Express

  beforeEach(() => {
    app = createHttpApp({
      conversations: new InMemoryConversationStore(),
      messages: new InMemoryMessageStore(),
      tokenVerifier: new FixedTokenVerifier(),
      corsOrigins: ['http://localhost:3000'],
    })
  })

  describe('authentication', () => {
    it('rejects a request with no Authorization header', async () => {
      const res = await request(app).get('/conversations')
      expect(res.status).toBe(401)
    })

    it('rejects a request with an unverifiable token', async () => {
      const res = await request(app).get('/conversations').set('Authorization', 'Bearer garbage')
      expect(res.status).toBe(401)
    })

    it('does not require auth for /health or /ready', async () => {
      const healthRes = await request(app).get('/health')
      const readyRes = await request(app).get('/ready')
      expect(healthRes.status).toBe(200)
      expect(readyRes.status).toBe(200)
    })

    it('does not require auth for /metrics', async () => {
      const res = await request(app).get('/metrics')
      expect(res.status).toBe(200)
    })
  })

  // This is the class of bug that made the whole REST API unreachable from
  // a browser with no CORS middleware at all: a preflight OPTIONS request
  // carries no Authorization header (that's the point of preflight), so if
  // auth middleware ran first it 401'd every preflight and the browser
  // blocked the real request before sending it - see corsOrigins on
  // HttpAppConfig for the full explanation.
  describe('CORS', () => {
    it('answers a preflight OPTIONS request without requiring auth', async () => {
      const res = await request(app)
        .options('/conversations')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization')

      expect(res.status).toBeLessThan(300)
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    })

    it('stamps Access-Control-Allow-Origin on a real request from an allowed origin', async () => {
      const res = await authed(app, 'get', '/conversations', 'user_a').set(
        'Origin',
        'http://localhost:3000',
      )
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    })

    it('does not stamp Access-Control-Allow-Origin for a disallowed origin', async () => {
      const res = await authed(app, 'get', '/conversations', 'user_a').set(
        'Origin',
        'https://not-allowed.example.com',
      )
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  describe('POST /conversations', () => {
    it('creates a conversation when the caller is a participant', async () => {
      const res = await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })

      expect(res.status).toBe(201)
      expect(res.body.participants.map((p: { userId: string }) => p.userId)).toEqual([
        'user_a',
        'user_b',
      ])
    })

    it('rejects creating a conversation the caller is not part of', async () => {
      const res = await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_b'],
      })
      expect(res.status).toBe(403)
    })

    it('rejects a malformed participantIds field', async () => {
      const res = await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: 'user_b',
      })
      expect(res.status).toBe(400)
    })

    it('rejects a participantIds array over the configured cap', async () => {
      const tooMany = Array.from({ length: 51 }, (_, i) => `user_${i}`)
      tooMany[0] = 'user_a'
      const res = await authed(app, 'post', '/conversations', 'user_a').send({ participantIds: tooMany })
      expect(res.status).toBe(400)
    })

    it('accepts a participantIds array at exactly the cap', async () => {
      const atCap = Array.from({ length: 50 }, (_, i) => `user_${i}`)
      atCap[0] = 'user_a'
      const res = await authed(app, 'post', '/conversations', 'user_a').send({ participantIds: atCap })
      expect(res.status).toBe(201)
    })
  })

  describe('GET /conversations', () => {
    it("lists only the caller's conversations", async () => {
      await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })

      const res = await authed(app, 'get', '/conversations', 'user_a')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
    })
  })

  describe('GET /conversations/:id', () => {
    it('returns 404 for an unknown conversation', async () => {
      const res = await authed(app, 'get', '/conversations/missing', 'user_a')
      expect(res.status).toBe(404)
    })

    it('rejects a caller who is not a participant', async () => {
      const created = await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })
      const conversationId = created.body.id as string

      const res = await authed(app, 'get', `/conversations/${conversationId}`, 'user_c')
      expect(res.status).toBe(403)
    })
  })

  describe('messages', () => {
    async function createConversation() {
      const res = await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })
      return res.body.id as string
    }

    it('sends and lists a message', async () => {
      const conversationId = await createConversation()

      const sendRes = await authed(
        app,
        'post',
        `/conversations/${conversationId}/messages`,
        'user_a',
      ).send({
        body: 'hello',
      })
      expect(sendRes.status).toBe(201)
      expect(sendRes.body.body).toBe('hello')

      const listRes = await authed(
        app,
        'get',
        `/conversations/${conversationId}/messages`,
        'user_b',
      )
      expect(listRes.status).toBe(200)
      expect(listRes.body).toHaveLength(1)
    })

    it('counts a sent message in /metrics', async () => {
      function readCounter(text: string): number {
        const match = /^jiffy_messaging_messages_published_total (\d+)$/m.exec(text)
        return match ? Number(match[1]) : 0
      }

      const before = readCounter((await request(app).get('/metrics')).text)

      const conversationId = await createConversation()
      await authed(app, 'post', `/conversations/${conversationId}/messages`, 'user_a').send({
        body: 'hello',
      })

      const after = readCounter((await request(app).get('/metrics')).text)
      expect(after).toBe(before + 1)
    })

    it('rejects a non-string body', async () => {
      const conversationId = await createConversation()
      const res = await authed(
        app,
        'post',
        `/conversations/${conversationId}/messages`,
        'user_a',
      ).send({
        body: 42,
      })
      expect(res.status).toBe(400)
    })

    it('rejects a sender who is not a participant', async () => {
      const conversationId = await createConversation()
      const res = await authed(
        app,
        'post',
        `/conversations/${conversationId}/messages`,
        'user_c',
      ).send({
        body: 'hi',
      })
      expect(res.status).toBe(403)
    })

    it('rejects an invalid limit query parameter', async () => {
      const conversationId = await createConversation()
      const res = await authed(
        app,
        'get',
        `/conversations/${conversationId}/messages?limit=0`,
        'user_a',
      )
      expect(res.status).toBe(400)
    })

    it('rejects an invalid before query parameter', async () => {
      const conversationId = await createConversation()
      const res = await authed(
        app,
        'get',
        `/conversations/${conversationId}/messages?before=not-a-date`,
        'user_a',
      )
      expect(res.status).toBe(400)
    })
  })

  describe('POST /conversations/:id/read', () => {
    it('marks the conversation read and returns 204', async () => {
      const createRes = await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })
      const conversationId = createRes.body.id as string

      const res = await authed(app, 'post', `/conversations/${conversationId}/read`, 'user_a')
      expect(res.status).toBe(204)

      const getRes = await authed(app, 'get', `/conversations/${conversationId}`, 'user_a')
      const participant = getRes.body.participants.find(
        (p: { userId: string }) => p.userId === 'user_a',
      )
      expect(participant.lastReadAt).not.toBeNull()
    })
  })

  describe('conversation gate wiring', () => {
    it('allows creation with no gate configured, matching the pre-gate default', async () => {
      const res = await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })
      expect(res.status).toBe(201)
    })

    it('rejects creating a conversation the gate does not allow, even though the caller included themselves', async () => {
      const gate: ConversationGate = {
        async canCreateConversation() {
          return false
        },
      }
      const gatedApp = createHttpApp({
        conversations: new InMemoryConversationStore(),
        messages: new InMemoryMessageStore(),
        tokenVerifier: new FixedTokenVerifier(),
        conversationGate: gate,
        corsOrigins: ['http://localhost:3000'],
      })

      // This is exactly the shape of the bypass the gate closes: user_a is
      // in participantIds, so the router's own "must include yourself"
      // check passes, and the only thing left standing between user_a and
      // an unwanted conversation with user_b is the gate.
      const res = await authed(gatedApp, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })
      expect(res.status).toBe(403)
    })

    it('allows creation when the gate says yes', async () => {
      const gate: ConversationGate = {
        async canCreateConversation() {
          return true
        },
      }
      const gatedApp = createHttpApp({
        conversations: new InMemoryConversationStore(),
        messages: new InMemoryMessageStore(),
        tokenVerifier: new FixedTokenVerifier(),
        conversationGate: gate,
        corsOrigins: ['http://localhost:3000'],
      })

      const res = await authed(gatedApp, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })
      expect(res.status).toBe(201)
    })

    it('blocks sending on a conversation once the gate stops allowing it', async () => {
      let allowed = true
      const gate: ConversationGate = {
        async canCreateConversation() {
          return allowed
        },
      }
      const gatedApp = createHttpApp({
        conversations: new InMemoryConversationStore(),
        messages: new InMemoryMessageStore(),
        tokenVerifier: new FixedTokenVerifier(),
        conversationGate: gate,
        corsOrigins: ['http://localhost:3000'],
      })

      const createRes = await authed(gatedApp, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })
      expect(createRes.status).toBe(201)

      allowed = false

      const sendRes = await authed(
        gatedApp,
        'post',
        `/conversations/${createRes.body.id}/messages`,
        'user_a',
      ).send({
        body: 'still trying to talk',
      })
      expect(sendRes.status).toBe(403)
    })
  })

  describe('message bus wiring', () => {
    it('publishes a message sent over REST to the configured bus', async () => {
      const published: Message[] = []
      const bus: MessageBus = {
        async publish(message) {
          published.push(message)
        },
        onMessage() {
          return () => {}
        },
      }
      const busApp = createHttpApp({
        conversations: new InMemoryConversationStore(),
        messages: new InMemoryMessageStore(),
        tokenVerifier: new FixedTokenVerifier(),
        messageBus: bus,
        corsOrigins: ['http://localhost:3000'],
      })

      const createRes = await authed(busApp, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })
      await authed(busApp, 'post', `/conversations/${createRes.body.id}/messages`, 'user_a').send({
        body: 'hi',
      })

      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({ body: 'hi' })
    })
  })
})

describe('request logging', () => {
  // Exercises the exact redact config createHttpApp wires into pinoHttp
  // (LOG_REDACT_PATHS, imported rather than duplicated) against a
  // standalone app and a capturing stream, since the app under test above
  // logs through the shared singleton logger in observability/logger.ts,
  // which writes straight to stdout and is not something a test can
  // intercept without changing what production actually does.
  it('does not write the raw Authorization header value to the log output', async () => {
    const chunks: Buffer[] = []
    const capture = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback()
      },
    })
    const testLogger = pino({}, capture)

    const probe = express()
    probe.use(pinoHttp({ logger: testLogger, redact: LOG_REDACT_PATHS }))
    probe.get('/probe', (_req, res) => res.status(200).end())

    const secretToken = 'super-secret-jwt-value-that-must-not-be-logged'
    await request(probe).get('/probe').set('Authorization', `Bearer ${secretToken}`)

    const logged = Buffer.concat(chunks).toString('utf8')
    expect(logged).not.toContain(secretToken)
    expect(logged).toContain('"authorization":"[Redacted]"')
  })

  it('does not write the raw Cookie header value to the log output', async () => {
    const chunks: Buffer[] = []
    const capture = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback()
      },
    })
    const testLogger = pino({}, capture)

    const probe = express()
    probe.use(pinoHttp({ logger: testLogger, redact: LOG_REDACT_PATHS }))
    probe.get('/probe', (_req, res) => res.status(200).end())

    const secretCookie = 'session=super-secret-cookie-value'
    await request(probe).get('/probe').set('Cookie', secretCookie)

    const logged = Buffer.concat(chunks).toString('utf8')
    expect(logged).not.toContain(secretCookie)
    expect(logged).toContain('"cookie":"[Redacted]"')
  })
})
