import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { HttpConversationGate } from './http-conversation-gate.js'

type Handler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) => void

let server: Server | undefined

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
})

async function listen(handler: Handler): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server?.listen(0, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo')
  }
  return `http://127.0.0.1:${address.port}`
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('HttpConversationGate', () => {
  it('returns true when the host answers { allowed: true }', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allowed: true }))
    })

    const gate = new HttpConversationGate({ url, secret: 'shared-secret' })
    await expect(gate.canCreateConversation('user_a', ['user_a', 'user_b'])).resolves.toBe(true)
  })

  it('returns false when the host answers { allowed: false }', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allowed: false }))
    })

    const gate = new HttpConversationGate({ url, secret: 'shared-secret' })
    await expect(gate.canCreateConversation('user_a', ['user_a', 'user_b'])).resolves.toBe(false)
  })

  it('sends requesterId, participantIds, and the secret as a bearer token', async () => {
    let receivedAuth: string | undefined
    let receivedBody: unknown
    const url = await listen(async (req, res) => {
      receivedAuth = req.headers.authorization
      receivedBody = JSON.parse(await readBody(req))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allowed: true }))
    })

    const gate = new HttpConversationGate({ url, secret: 'shared-secret' })
    await gate.canCreateConversation('user_a', ['user_a', 'user_b'])

    expect(receivedAuth).toBe('Bearer shared-secret')
    expect(receivedBody).toEqual({ requesterId: 'user_a', participantIds: ['user_a', 'user_b'] })
  })

  it('fails closed on a non-2xx response', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid secret' }))
    })

    const gate = new HttpConversationGate({ url, secret: 'wrong-secret' })
    await expect(gate.canCreateConversation('user_a', ['user_a', 'user_b'])).resolves.toBe(false)
  })

  it('fails closed on a body that is not JSON', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('not json')
    })

    const gate = new HttpConversationGate({ url, secret: 'shared-secret' })
    await expect(gate.canCreateConversation('user_a', ['user_a', 'user_b'])).resolves.toBe(false)
  })

  it('fails closed on a body missing allowed: true', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })

    const gate = new HttpConversationGate({ url, secret: 'shared-secret' })
    await expect(gate.canCreateConversation('user_a', ['user_a', 'user_b'])).resolves.toBe(false)
  })

  it('fails closed when the host is unreachable', async () => {
    // Nothing is listening on this port once we close it immediately.
    const url = await listen((_req, res) => res.end())
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined

    const gate = new HttpConversationGate({ url, secret: 'shared-secret' })
    await expect(gate.canCreateConversation('user_a', ['user_a', 'user_b'])).resolves.toBe(false)
  })

  it('fails closed when the host does not respond within the timeout', async () => {
    const url = await listen(() => {
      // Deliberately never responds - the client's AbortSignal must fire first.
    })

    const gate = new HttpConversationGate({ url, secret: 'shared-secret', timeoutMs: 50 })
    await expect(gate.canCreateConversation('user_a', ['user_a', 'user_b'])).resolves.toBe(false)
  })
})
