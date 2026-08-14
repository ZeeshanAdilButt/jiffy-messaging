import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryConversationStore, InMemoryMessageStore } from '../adapters/in-memory/index.js'
import type { Message } from '../domain/index.js'
import type { ConversationGate, MessageBus, MessageNotifier } from '../ports/index.js'
import {
  ConversationNotAllowedError,
  ConversationNotFoundError,
  EmptyMessageError,
  MessagingService,
  NotAParticipantError,
} from './index.js'

class RecordingGate implements ConversationGate {
  calls: Array<{ requesterId: string; participantIds: string[] }> = []

  constructor(private allowed: boolean) {}

  async canCreateConversation(requesterId: string, participantIds: string[]): Promise<boolean> {
    this.calls.push({ requesterId, participantIds: [...participantIds] })
    return this.allowed
  }

  setAllowed(allowed: boolean): void {
    this.allowed = allowed
  }
}

class RecordingNotifier implements MessageNotifier {
  calls: Array<{ message: Message; recipientIds: string[] }> = []

  async notify(message: Message, recipientIds: string[]): Promise<void> {
    this.calls.push({ message, recipientIds: [...recipientIds] })
  }
}

describe('MessagingService', () => {
  let service: MessagingService

  beforeEach(() => {
    service = new MessagingService(new InMemoryConversationStore(), new InMemoryMessageStore())
  })

  describe('createConversation', () => {
    it('creates a conversation with the given participants', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      expect(conversation.participants.map((p) => p.userId)).toEqual(['a', 'b'])
    })
  })

  describe('listConversations', () => {
    it('returns only the conversations the user participates in', async () => {
      const withUser = await service.createConversation('a', ['a', 'b'])
      await service.createConversation('b', ['b', 'c'])

      const conversations = await service.listConversations('a')
      expect(conversations.map((c) => c.id)).toEqual([withUser.id])
    })

    it('returns an empty array for a user in no conversations', async () => {
      await expect(service.listConversations('nobody')).resolves.toEqual([])
    })

    it('attaches null lastMessage to a conversation nobody has sent into yet', async () => {
      await service.createConversation('a', ['a', 'b'])

      const [conversation] = await service.listConversations('a')
      expect(conversation!.lastMessage).toBeNull()
    })

    it('attaches the most recent message as lastMessage', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'first' })
      await service.sendMessage({ conversationId: conversation.id, senderId: 'b', body: 'second' })

      const [listed] = await service.listConversations('a')
      expect(listed!.lastMessage?.body).toBe('second')
    })
  })

  describe('sendMessage', () => {
    it('sends a message from a participant', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      const message = await service.sendMessage({
        conversationId: conversation.id,
        senderId: 'a',
        body: 'hi',
      })
      expect(message).toMatchObject({ conversationId: conversation.id, senderId: 'a', body: 'hi' })
    })

    it('rejects an empty body', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      await expect(
        service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: '   ' }),
      ).rejects.toThrow(EmptyMessageError)
    })

    it('publishes the message to the configured message bus', async () => {
      const published: Message[] = []
      const bus: MessageBus = {
        async publish(message) {
          published.push(message)
        },
        onMessage() {
          return () => {}
        },
      }
      const busService = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
        bus,
      )
      const conversation = await busService.createConversation('a', ['a', 'b'])

      const message = await busService.sendMessage({
        conversationId: conversation.id,
        senderId: 'a',
        body: 'hi',
      })

      expect(published).toEqual([message])
    })

    it('still returns the message when the bus publish rejects', async () => {
      const bus: MessageBus = {
        async publish() {
          throw new Error('bus unavailable')
        },
        onMessage() {
          return () => {}
        },
      }
      const busService = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
        bus,
      )
      const conversation = await busService.createConversation('a', ['a', 'b'])

      await expect(
        busService.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' }),
      ).resolves.toMatchObject({ body: 'hi' })
    })

    it('rejects a sender who is not a participant', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      await expect(
        service.sendMessage({ conversationId: conversation.id, senderId: 'z', body: 'hi' }),
      ).rejects.toThrow(NotAParticipantError)
    })

    it('rejects an unknown conversation', async () => {
      await expect(
        service.sendMessage({ conversationId: 'missing', senderId: 'a', body: 'hi' }),
      ).rejects.toThrow(ConversationNotFoundError)
    })

    it('notifies every recipient except the sender', async () => {
      const notifier = new RecordingNotifier()
      const notifyingService = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
        undefined,
        undefined,
        notifier,
      )
      const conversation = await notifyingService.createConversation('a', ['a', 'b', 'c'])

      const message = await notifyingService.sendMessage({
        conversationId: conversation.id,
        senderId: 'a',
        body: 'hi',
      })

      expect(notifier.calls).toEqual([{ message, recipientIds: ['b', 'c'] }])
    })

    it('still returns the message when the notifier rejects', async () => {
      const notifier: MessageNotifier = {
        async notify() {
          throw new Error('notify endpoint unreachable')
        },
      }
      const notifyingService = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
        undefined,
        undefined,
        notifier,
      )
      const conversation = await notifyingService.createConversation('a', ['a', 'b'])

      await expect(
        notifyingService.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' }),
      ).resolves.toMatchObject({ body: 'hi' })
    })
  })

  describe('listMessages', () => {
    it('lists messages for a participant', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' })

      const messages = await service.listMessages(conversation.id, 'b')
      expect(messages.map((m) => m.body)).toEqual(['hi'])
    })

    it('rejects a requester who is not a participant', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      await expect(service.listMessages(conversation.id, 'z')).rejects.toThrow(NotAParticipantError)
    })
  })

  describe('markRead', () => {
    it('records when a participant read the conversation', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      const readAt = new Date('2026-01-01T00:00:00Z')

      await service.markRead(conversation.id, 'a', readAt)

      const updated = await service.getConversation(conversation.id, 'a')
      expect(updated.participants.find((p) => p.userId === 'a')?.lastReadAt).toEqual(readAt)
    })

    it('rejects a non participant', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      await expect(service.markRead(conversation.id, 'z', new Date())).rejects.toThrow(
        NotAParticipantError,
      )
    })
  })

  describe('conversation gate', () => {
    it('defaults to allowing any two participants when no gate is configured', async () => {
      const unconfigured = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
      )

      await expect(unconfigured.createConversation('a', ['a', 'b'])).resolves.toMatchObject({})
    })

    it('creates the conversation when the gate allows it', async () => {
      const gate = new RecordingGate(true)
      const gated = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
        undefined,
        gate,
      )

      const conversation = await gated.createConversation('a', ['a', 'b'])

      expect(conversation.participants.map((p) => p.userId)).toEqual(['a', 'b'])
      expect(gate.calls).toEqual([{ requesterId: 'a', participantIds: ['a', 'b'] }])
    })

    it('rejects creation with ConversationNotAllowedError when the gate says no', async () => {
      const gate = new RecordingGate(false)
      const gated = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
        undefined,
        gate,
      )

      await expect(gated.createConversation('a', ['a', 'b'])).rejects.toThrow(
        ConversationNotAllowedError,
      )
    })

    it('never writes a conversation when the gate rejects it', async () => {
      const gate = new RecordingGate(false)
      const conversations = new InMemoryConversationStore()
      const gated = new MessagingService(conversations, new InMemoryMessageStore(), undefined, gate)

      await expect(gated.createConversation('a', ['a', 'b'])).rejects.toThrow(
        ConversationNotAllowedError,
      )
      await expect(conversations.findByParticipant('a')).resolves.toEqual([])
    })

    it('re-checks the gate on every send, not only at creation', async () => {
      const gate = new RecordingGate(true)
      const gated = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
        undefined,
        gate,
      )
      const conversation = await gated.createConversation('a', ['a', 'b'])
      gate.calls = []

      await gated.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' })

      expect(gate.calls).toEqual([{ requesterId: 'a', participantIds: ['a', 'b'] }])
    })

    it('rejects a send with ConversationNotAllowedError once the gate stops allowing it', async () => {
      const gate = new RecordingGate(true)
      const gated = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
        undefined,
        gate,
      )
      const conversation = await gated.createConversation('a', ['a', 'b'])

      // Mirrors a revoked relationship on the host side: the gate answered
      // yes at creation time and now answers no, with nothing else about
      // the conversation having changed.
      gate.setAllowed(false)

      await expect(
        gated.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' }),
      ).rejects.toThrow(ConversationNotAllowedError)
    })

    it('never writes the message when the gate rejects a send', async () => {
      const gate = new RecordingGate(true)
      const messages = new InMemoryMessageStore()
      const gated = new MessagingService(new InMemoryConversationStore(), messages, undefined, gate)
      const conversation = await gated.createConversation('a', ['a', 'b'])
      gate.setAllowed(false)

      await expect(
        gated.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' }),
      ).rejects.toThrow(ConversationNotAllowedError)

      await expect(messages.listByConversation(conversation.id)).resolves.toEqual([])
    })
  })
})
