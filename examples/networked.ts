/**
 * Talking to a running standalone jiffy-messaging server over its network
 * API: REST for everything except live push, plain WebSocket for that.
 *
 * Point this at `docker compose up` from the repo root - it signs tokens
 * with the same JWT_SECRET docker-compose.yml configures for local dev.
 * A real consumer signs tokens with whatever its own platform already
 * uses for its users; this stands in for that with a plain jose SignJWT
 * since there is no real host platform here. Run with:
 * pnpm example:networked
 *
 * See embedded.ts for the same package used in-process instead.
 */
import { SignJWT } from 'jose'
import { WebSocket } from 'ws'

const BASE_URL = process.env.JIFFY_MESSAGING_URL ?? 'http://localhost:8080'
const WS_URL = process.env.JIFFY_MESSAGING_WS_URL ?? 'ws://localhost:8080'
const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'local-dev-secret-do-not-use-in-production')

interface ConversationResponse {
  id: string
}

interface MessageResponse {
  id: string
  body: string
}

async function signToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(secret)
}

async function main() {
  const mentorToken = await signToken('mentor_1')
  const menteeToken = await signToken('mentee_1')

  const createRes = await fetch(`${BASE_URL}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mentorToken}` },
    body: JSON.stringify({ participantIds: ['mentor_1', 'mentee_1'] }),
  })
  if (!createRes.ok) {
    throw new Error(`failed to create conversation: ${createRes.status} ${await createRes.text()}`)
  }
  const conversation = (await createRes.json()) as ConversationResponse
  console.log('created conversation', conversation.id)

  // The mentee connects over WebSocket before the mentor sends anything,
  // so the live push below actually has somewhere to arrive.
  const socket = new WebSocket(`${WS_URL}/?token=${menteeToken}`)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  const delivered = new Promise<void>((resolve) => {
    socket.once('message', (data) => {
      console.log('mentee received live over WebSocket:', JSON.parse(String(data)).body)
      resolve()
    })
  })

  const sendRes = await fetch(`${BASE_URL}/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mentorToken}` },
    body: JSON.stringify({ body: 'How did the last session go?' }),
  })
  if (!sendRes.ok) {
    throw new Error(`failed to send message: ${sendRes.status} ${await sendRes.text()}`)
  }
  const message = (await sendRes.json()) as MessageResponse
  console.log('mentor sent over REST:', message.id)

  await delivered
  socket.close()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
