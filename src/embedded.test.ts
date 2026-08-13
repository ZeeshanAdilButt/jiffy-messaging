import { describe, expect, it } from 'vitest'

import { InMemoryConversationStore, InMemoryMessageStore } from './adapters/in-memory/index.js'
import { createEmbeddedMessaging } from './embedded.js'
import { ConversationNotAllowedError } from './core/index.js'
import type { ConversationGate, TokenVerifier, VerifiedIdentity } from './ports/index.js'

class FakeTokenVerifier implements TokenVerifier {
  constructor(private readonly identity: VerifiedIdentity | null) {}

  async verify(): Promise<VerifiedIdentity> {
    if (!this.identity) {
      throw new Error('invalid token')
    }
    return this.identity
  }
}

describe('createEmbeddedMessaging', () => {
  it('wires the given adapters into a working messaging service', async () => {
    const embedded = createEmbeddedMessaging({
      conversations: new InMemoryConversationStore(),
      messages: new InMemoryMessageStore(),
      tokenVerifier: new FakeTokenVerifier({ userId: 'user_1' }),
    })

    const conversation = await embedded.messaging.createConversation('user_1', ['user_1', 'user_2'])
    const message = await embedded.messaging.sendMessage({
      conversationId: conversation.id,
      senderId: 'user_1',
      body: 'hi',
    })

    expect(message.body).toBe('hi')
  })

  it('delegates verifyToken to the configured token verifier', async () => {
    const embedded = createEmbeddedMessaging({
      conversations: new InMemoryConversationStore(),
      messages: new InMemoryMessageStore(),
      tokenVerifier: new FakeTokenVerifier({ userId: 'user_1' }),
    })

    await expect(embedded.verifyToken('any-token')).resolves.toEqual({ userId: 'user_1' })
  })

  it('propagates a rejected token instead of swallowing it', async () => {
    const embedded = createEmbeddedMessaging({
      conversations: new InMemoryConversationStore(),
      messages: new InMemoryMessageStore(),
      tokenVerifier: new FakeTokenVerifier(null),
    })

    await expect(embedded.verifyToken('bad-token')).rejects.toThrow('invalid token')
  })

  it('defers conversation creation to the configured gate', async () => {
    const gate: ConversationGate = {
      async canCreateConversation(requesterId, participantIds) {
        return requesterId === 'user_1' && participantIds.includes('user_2')
      },
    }
    const embedded = createEmbeddedMessaging({
      conversations: new InMemoryConversationStore(),
      messages: new InMemoryMessageStore(),
      tokenVerifier: new FakeTokenVerifier({ userId: 'user_1' }),
      conversationGate: gate,
    })

    await expect(
      embedded.messaging.createConversation('user_1', ['user_1', 'user_2']),
    ).resolves.toMatchObject({})
    await expect(
      embedded.messaging.createConversation('user_1', ['user_1', 'user_3']),
    ).rejects.toThrow(ConversationNotAllowedError)
  })
})
