import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { HttpMessageNotifier } from './http-message-notifier.js'

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

const MESSAGE = {
  id: 'msg_1',
  conversationId: 'conv_1',
  senderId: 'user_a',
  body: 'hi',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}

describe('HttpMessageNotifier', () => {
  it('sends the message and recipientIds with the secret as a bearer token', async () => {
    let receivedAuth: string | undefined
    let receivedBody: unknown
    const url = await listen(async (req, res) => {
      receivedAuth = req.headers.authorization
      receivedBody = JSON.parse(await readBody(req))
      res.writeHead(200)
      res.end()
    })

    const notifier = new HttpMessageNotifier({ url, secret: 'shared-secret' })
    await notifier.notify(MESSAGE, ['user_b', 'user_c'])

    expect(receivedAuth).toBe('Bearer shared-secret')
    expect(receivedBody).toEqual({
      messageId: 'msg_1',
      conversationId: 'conv_1',
      senderId: 'user_a',
      recipientIds: ['user_b', 'user_c'],
      body: 'hi',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('does not call the host at all when there are no recipients', async () => {
    let called = false
    const url = await listen((_req, res) => {
      called = true
      res.writeHead(200)
      res.end()
    })

    const notifier = new HttpMessageNotifier({ url, secret: 'shared-secret' })
    await notifier.notify(MESSAGE, [])

    expect(called).toBe(false)
  })

  // Unlike HttpConversationGate this is not an authorization check, so
  // there is nothing to fail closed on - every one of these must resolve
  // without throwing, since the message it fires for is already sent.

  it('resolves without throwing on a non-2xx response', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(401)
      res.end()
    })

    const notifier = new HttpMessageNotifier({ url, secret: 'wrong-secret' })
    await expect(notifier.notify(MESSAGE, ['user_b'])).resolves.toBeUndefined()
  })

  it('resolves without throwing when the host is unreachable', async () => {
    const url = await listen((_req, res) => res.end())
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined

    const notifier = new HttpMessageNotifier({ url, secret: 'shared-secret' })
    await expect(notifier.notify(MESSAGE, ['user_b'])).resolves.toBeUndefined()
  })

  it('resolves without throwing when the host does not respond within the timeout', async () => {
    const url = await listen(() => {
      // Deliberately never responds - the client's AbortSignal must fire first.
    })

    const notifier = new HttpMessageNotifier({ url, secret: 'shared-secret', timeoutMs: 50 })
    await expect(notifier.notify(MESSAGE, ['user_b'])).resolves.toBeUndefined()
  })
})
