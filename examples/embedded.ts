/**
 * Running jiffy-messaging in-process: no HTTP, no network hop, just calls
 * against adapters the host supplies.
 *
 * Uses in-memory adapters so this runs with nothing else installed. A real
 * service swaps in the Postgres adapters and its own TokenVerifier;
 * nothing below changes.
 *
 * Run with: make example-embedded
 */
import {
  createEmbeddedMessaging,
  InMemoryConversationStore,
  InMemoryMessageStore,
  NotAParticipantError,
  type TokenVerifier,
} from '../src/index.js'

// Stands in for whatever already authenticates your users. Trusting the
// token as the user id keeps this example to one file; real deployments
// use the JWT adapter, or their own implementation of this interface.
class StubTokenVerifier implements TokenVerifier {
  async verify(token: string) {
    return { userId: token }
  }
}

async function main() {
  const jiffy = createEmbeddedMessaging({
    conversations: new InMemoryConversationStore(),
    messages: new InMemoryMessageStore(),
    tokenVerifier: new StubTokenVerifier(),
  })

  const alice = await jiffy.verifyToken('user_alice')
  const bob = await jiffy.verifyToken('user_bob')

  const conversation = await jiffy.messaging.createConversation([alice.userId, bob.userId])
  console.log('conversation:', conversation.id)

  await jiffy.messaging.sendMessage({
    conversationId: conversation.id,
    senderId: alice.userId,
    body: 'Are we still on for tomorrow?',
  })
  await jiffy.messaging.sendMessage({
    conversationId: conversation.id,
    senderId: bob.userId,
    body: 'Yes, 3pm works.',
  })

  const history = await jiffy.messaging.listMessages(conversation.id, bob.userId)
  console.log('history:')
  for (const message of history) {
    console.log(`  ${message.senderId}: ${message.body}`)
  }

  await jiffy.messaging.markRead(conversation.id, bob.userId, new Date())
  const afterRead = await jiffy.messaging.getConversation(conversation.id, bob.userId)
  const bobState = afterRead.participants.find((p) => p.userId === bob.userId)
  console.log('bob last read at:', bobState?.lastReadAt?.toISOString())

  // Participation is enforced on every operation, not just at creation.
  try {
    await jiffy.messaging.sendMessage({
      conversationId: conversation.id,
      senderId: 'user_carol',
      body: 'Let me in',
    })
  } catch (error) {
    if (!(error instanceof NotAParticipantError)) throw error
    console.log('rejected non-participant:', error.message)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
