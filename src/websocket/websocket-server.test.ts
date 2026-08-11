import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { InMemoryConversationStore } from '../adapters/in-memory/index.js'
import { InProcessMessageBus } from '../adapters/in-process/index.js'
import type { TokenVerifier, VerifiedIdentity } from '../ports/index.js'
import { attachWebSocketServer } from './websocket-server.js'

class FixedTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedIdentity> {
    if (token === 'user_a' || token === 'user_b') {
      return { userId: token }
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
