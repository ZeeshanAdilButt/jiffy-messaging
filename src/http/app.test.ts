import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Express } from 'express'

import { InMemoryConversationStore, InMemoryMessageStore } from '../adapters/in-memory/index.js'
import type { Message } from '../domain/index.js'
import type { MessageBus, TokenVerifier, VerifiedIdentity } from '../ports/index.js'
import { createHttpApp } from './app.js'

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

  describe('POST /conversations', () => {
    it('creates a conversation when the caller is a participant', async () => {
      const res = await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })

      expect(res.status).toBe(201)
      expect(res.body.participants.map((p: { userId: string }) => p.userId)).toEqual(['user_a', 'user_b'])
    })

    it('rejects creating a conversation the caller is not part of', async () => {
      const res = await authed(app, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_b'],
      })
      expect(res.status).toBe(403)
    })

    it('rejects a malformed participantIds field', async () => {
      const res = await authed(app, 'post', '/conversations', 'user_a').send({ participantIds: 'user_b' })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /conversations', () => {
    it('lists only the caller\'s conversations', async () => {
      await authed(app, 'post', '/conversations', 'user_a').send({ participantIds: ['user_a', 'user_b'] })

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

      const sendRes = await authed(app, 'post', `/conversations/${conversationId}/messages`, 'user_a').send({
        body: 'hello',
      })
      expect(sendRes.status).toBe(201)
      expect(sendRes.body.body).toBe('hello')

      const listRes = await authed(app, 'get', `/conversations/${conversationId}/messages`, 'user_b')
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
      await authed(app, 'post', `/conversations/${conversationId}/messages`, 'user_a').send({ body: 'hello' })

      const after = readCounter((await request(app).get('/metrics')).text)
      expect(after).toBe(before + 1)
    })

    it('rejects a non-string body', async () => {
      const conversationId = await createConversation()
      const res = await authed(app, 'post', `/conversations/${conversationId}/messages`, 'user_a').send({
        body: 42,
      })
      expect(res.status).toBe(400)
    })

    it('rejects a sender who is not a participant', async () => {
      const conversationId = await createConversation()
      const res = await authed(app, 'post', `/conversations/${conversationId}/messages`, 'user_c').send({
        body: 'hi',
      })
      expect(res.status).toBe(403)
    })

    it('rejects an invalid limit query parameter', async () => {
      const conversationId = await createConversation()
      const res = await authed(app, 'get', `/conversations/${conversationId}/messages?limit=0`, 'user_a')
      expect(res.status).toBe(400)
    })

    it('rejects an invalid before query parameter', async () => {
      const conversationId = await createConversation()
      const res = await authed(app, 'get', `/conversations/${conversationId}/messages?before=not-a-date`, 'user_a')
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
      const participant = getRes.body.participants.find((p: { userId: string }) => p.userId === 'user_a')
      expect(participant.lastReadAt).not.toBeNull()
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
      })

      const createRes = await authed(busApp, 'post', '/conversations', 'user_a').send({
        participantIds: ['user_a', 'user_b'],
      })
      await authed(busApp, 'post', `/conversations/${createRes.body.id}/messages`, 'user_a').send({ body: 'hi' })

      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({ body: 'hi' })
    })
  })
})
