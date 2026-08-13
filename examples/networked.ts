/**
 * Talking to a running jiffy-messaging service: REST for everything except
 * live delivery, WebSocket for that.
 *
 * Expects a server on localhost:8080 - `make up` brings one up, and this
 * signs tokens with the same dev secret that compose file configures. A
 * real client sends whatever tokens its own auth already issues.
 *
 * Run with: make example-networked
 */
import { SignJWT } from 'jose'
import { WebSocket } from 'ws'

const BASE_URL = process.env.JIFFY_MESSAGING_URL ?? 'http://localhost:8080'
const WS_URL = process.env.JIFFY_MESSAGING_WS_URL ?? 'ws://localhost:8080'
const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'local-dev-secret-do-not-use-in-production')

interface Conversation {
  id: string
}

interface Message {
  id: string
  senderId: string
  body: string
}

function signToken(userId: string): Promise<string> {
  // A short, explicit expiration is not optional: the service rejects any
  // token that has no "exp" claim at all, and a real one should not
  // outlive the session it was issued for anyway.
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret)
}

async function call<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init.headers },
  })
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

async function main() {
  const aliceToken = await signToken('user_alice')
  const bobToken = await signToken('user_bob')

  const conversation = await call<Conversation>('/conversations', aliceToken, {
    method: 'POST',
    body: JSON.stringify({ participantIds: ['user_alice', 'user_bob'] }),
  })
  console.log('conversation:', conversation.id)

  // Connect before sending, so the live push has somewhere to land.
  const socket = new WebSocket(`${WS_URL}/?token=${bobToken}`)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  console.log('bob connected over WebSocket')

  const delivered = new Promise<Message>((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(String(data)) as Message))
  })

  const sent = await call<Message>(`/conversations/${conversation.id}/messages`, aliceToken, {
    method: 'POST',
    body: JSON.stringify({ body: 'Are we still on for tomorrow?' }),
  })
  console.log('alice sent over REST:', sent.id)

  const pushed = await delivered
  console.log('bob received over WebSocket:', `${pushed.senderId}: ${pushed.body}`)

  const history = await call<Message[]>(`/conversations/${conversation.id}/messages`, bobToken)
  console.log('history has', history.length, 'message(s)')

  socket.close()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
