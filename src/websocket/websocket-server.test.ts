import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { InMemoryConversationStore } from '../adapters/in-memory/index.js'
import { InProcessMessageBus } from '../adapters/in-process/index.js'
import type { TokenVerifier, VerifiedIdentity } from '../ports/index.js'
import { ConnectionRateLimiter } from './connection-rate-limiter.js'
import { attachWebSocketServer } from './websocket-server.js'

class FixedTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedIdentity> {
    if (token === 'user_a' || token === 'user_b') {
      return { userId: token }
    }
    throw new Error('unknown token')
  }
}

/** Reports whatever expiresAt the test configures it with, so the expiry-driven close path can be exercised without waiting on a real JWT. */
class ExpiringTokenVerifier implements TokenVerifier {
  constructor(private readonly expiresAt: Date) {}

  async verify(token: string): Promise<VerifiedIdentity> {
    if (token === 'user_a') {
      return { userId: token, expiresAt: this.expiresAt }
    }
    throw new Error('unknown token')
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo')
  }
  return address.port
}

describe('attachWebSocketServer', () => {
  let server: Server
  let port: number
  let conversations: InMemoryConversationStore
  let messageBus: InProcessMessageBus
  let registry: ReturnType<typeof attachWebSocketServer>
  const openSockets: WebSocket[] = []

  beforeEach(async () => {
    server = createServer()
    conversations = new InMemoryConversationStore()
    messageBus = new InProcessMessageBus()
    registry = attachWebSocketServer({
      server,
      tokenVerifier: new FixedTokenVerifier(),
      conversations,
      messageBus,
    })
    port = await listen(server)
  })

  afterEach(async () => {
    for (const socket of openSockets) {
      socket.close()
    }
    openSockets.length = 0
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function connect(token: string): WebSocket {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
    openSockets.push(socket)
    return socket
  }

  it('accepts a connection with a valid token', async () => {
    const socket = connect('user_a')
    await once(socket, 'open')
    expect(socket.readyState).toBe(WebSocket.OPEN)
  })

  it('rejects a connection with no token', async () => {
    const socket = connect('')
    // events.once() special-cases 'error': it rejects for any event other
    // than 'error' if 'error' fires first, so waiting on 'error' directly
    // is what actually observes a rejected handshake here.
    const [error] = await once(socket, 'error')
    expect(String(error)).toContain('401')
  })

  it('rejects a connection with an unverifiable token', async () => {
    const socket = connect('garbage')
    const [error] = await once(socket, 'error')
    expect(String(error)).toContain('401')
  })

  it('delivers a published message to a connected participant', async () => {
    const conversation = await conversations.create(['user_a', 'user_b'])
    const socket = connect('user_a')
    await once(socket, 'open')

    const messagePromise = once(socket, 'message')
    await messageBus.publish({
      id: 'm1',
      conversationId: conversation.id,
      senderId: 'user_b',
      body: 'hello',
      createdAt: new Date(),
    })

    const [data] = await messagePromise
    const received = JSON.parse(String(data))
    expect(received).toMatchObject({ id: 'm1', body: 'hello' })
  })

  it('does not deliver a message to a socket for a non-participant', async () => {
    const conversation = await conversations.create(['user_a'])
    const socket = connect('user_b')
    await once(socket, 'open')

    const received: unknown[] = []
    socket.on('message', (data) => received.push(data))

    await messageBus.publish({
      id: 'm1',
      conversationId: conversation.id,
      senderId: 'user_a',
      body: 'private to user_a',
      createdAt: new Date(),
    })

    // No event to await for "nothing arrived" - give delivery a moment to
    // happen if it were going to, then assert it didn't.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).toEqual([])
  })

  it('removes a closed connection from the registry', async () => {
    const socket = connect('user_a')
    await once(socket, 'open')
    expect(registry.get('user_a').size).toBe(1)

    socket.close()
    await once(socket, 'close')
    await vi.waitFor(() => expect(registry.get('user_a').size).toBe(0))
  })
})

describe('attachWebSocketServer connection rate limiting', () => {
  let server: Server
  let port: number
  const openSockets: WebSocket[] = []

  beforeEach(async () => {
    server = createServer()
    attachWebSocketServer({
      server,
      tokenVerifier: new FixedTokenVerifier(),
      conversations: new InMemoryConversationStore(),
      messageBus: new InProcessMessageBus(),
      connectionRateLimiter: new ConnectionRateLimiter(1, 60_000),
    })
    port = await listen(server)
  })

  afterEach(async () => {
    for (const socket of openSockets) {
      socket.close()
    }
    openSockets.length = 0
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function connect(token: string): WebSocket {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
    openSockets.push(socket)
    return socket
  }

  it('rejects a connection attempt past the configured limit', async () => {
    const first = connect('user_a')
    await once(first, 'open')

    const second = connect('user_a')
    const [error] = await once(second, 'error')
    expect(String(error)).toContain('429')
  })
})

describe('attachWebSocketServer token expiry', () => {
  let server: Server
  let port: number
  const openSockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of openSockets) {
      socket.close()
    }
    openSockets.length = 0
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function connect(token: string): WebSocket {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
    openSockets.push(socket)
    return socket
  }

  it('closes an open connection once the token it was opened with expires', async () => {
    server = createServer()
    attachWebSocketServer({
      server,
      tokenVerifier: new ExpiringTokenVerifier(new Date(Date.now() + 50)),
      conversations: new InMemoryConversationStore(),
      messageBus: new InProcessMessageBus(),
    })
    port = await listen(server)

    const socket = connect('user_a')
    await once(socket, 'open')
    expect(socket.readyState).toBe(WebSocket.OPEN)

    const [code] = await once(socket, 'close')
    expect(code).toBe(4401)
  })

  it('does not schedule a close for a token verifier that reports no expiry', async () => {
    server = createServer()
    attachWebSocketServer({
      server,
      tokenVerifier: new FixedTokenVerifier(),
      conversations: new InMemoryConversationStore(),
      messageBus: new InProcessMessageBus(),
    })
    port = await listen(server)

    const socket = connect('user_a')
    await once(socket, 'open')

    // No 'close' event within a window well past what the expiry test
    // above waits - if a close were scheduled by mistake for a verifier
    // that never set expiresAt, this would catch it.
    const closed = await Promise.race([
      once(socket, 'close').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ])
    expect(closed).toBe(false)
    expect(socket.readyState).toBe(WebSocket.OPEN)
  })
})
