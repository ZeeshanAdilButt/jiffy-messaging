/**
 * Embedding jiffy-messaging directly in a host process: no HTTP, no
 * network hop, just function calls against adapters the host supplies.
 *
 * In-memory adapters here so this runs standalone with nothing else
 * running - a real host would pass Postgres adapters instead (see
 * src/adapters/postgres). Run with: pnpm example:embedded
 *
 * See networked.ts for the same package used as a standalone container
 * over REST and WebSocket instead.
 */
import {
  createEmbeddedMessaging,
  InMemoryConversationStore,
  InMemoryMessageStore,
  type TokenVerifier,
} from '../src/index.js'

// A host platform's own auth decides who a user is; jiffy-messaging just
// needs something satisfying TokenVerifier. A real host would use the JWT
// adapter (src/adapters/jwt) against its own tokens instead of a stub
// that trusts whatever string it is given.
class StubTokenVerifier implements TokenVerifier {
  async verify(token: string) {
    return { userId: token }
  }
}

async function main() {
  const embedded = createEmbeddedMessaging({
    conversations: new InMemoryConversationStore(),
    messages: new InMemoryMessageStore(),
    tokenVerifier: new StubTokenVerifier(),
  })

  const mentor = await embedded.verifyToken('mentor_1')
  const mentee = await embedded.verifyToken('mentee_1')

  const conversation = await embedded.messaging.createConversation([mentor.userId, mentee.userId])
  console.log('created conversation', conversation.id)

  const message = await embedded.messaging.sendMessage({
    conversationId: conversation.id,
    senderId: mentor.userId,
    body: 'How did the last session go?',
  })
  console.log('mentor sent:', message.body)

  await embedded.messaging.markRead(conversation.id, mentee.userId, new Date())
  const messages = await embedded.messaging.listMessages(conversation.id, mentee.userId)
  console.log('mentee now sees', messages.length, 'message(s), and has marked the conversation read')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
