import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryConversationStore, InMemoryMessageStore } from '../adapters/in-memory/index.js'
import type { Message } from '../domain/index.js'
import type { ConversationGate, MessageBus, MessageNotifier } from '../ports/index.js'
import {
  ConversationNotAllowedError,
  ConversationNotFoundError,
  EmptyMessageError,
  MessageNotFoundError,
  MessagingService,
  NotAParticipantError,
  NotMessageAuthorError,
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

class RecordingBus implements MessageBus {
  published: Message[] = []

  async publish(message: Message): Promise<void> {
    this.published.push(message)
  }

  onMessage(): () => void {
    return () => {}
  }
}

/**
 * Both delete paths are timestamp-based and both are compared strictly, so
 * two writes inside the same millisecond would make an assertion about
 * "after the delete" depend on how fast the machine is. One tick is enough
 * to keep the clock moving between them.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

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

  describe('deleteMessage', () => {
    it('tombstones the message rather than removing it', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      const sent = await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'oops' })

      const deleted = await service.deleteMessage(conversation.id, sent.id, 'a')

      expect(deleted.id).toBe(sent.id)
      expect(deleted.deletedAt).toBeInstanceOf(Date)
      expect(deleted.body).toBe('')
    })

    it('leaves the tombstone in the thread for both participants', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      const sent = await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'oops' })
      await service.deleteMessage(conversation.id, sent.id, 'a')

      for (const userId of ['a', 'b']) {
        const messages = await service.listMessages(conversation.id, userId)
        expect(messages).toHaveLength(1)
        expect(messages[0]!.body).toBe('')
        expect(messages[0]!.deletedAt).toBeInstanceOf(Date)
      }
    })

    it('refuses to let a participant delete a message they did not send', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      const sent = await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' })

      await expect(service.deleteMessage(conversation.id, sent.id, 'b')).rejects.toThrow(NotMessageAuthorError)
      const messages = await service.listMessages(conversation.id, 'b')
      expect(messages[0]!.body).toBe('hi')
    })

    it('refuses a caller who is not in the conversation at all', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      const sent = await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' })

      await expect(service.deleteMessage(conversation.id, sent.id, 'c')).rejects.toThrow(NotAParticipantError)
    })

    it('reports a message from another conversation as missing', async () => {
      const mine = await service.createConversation('a', ['a', 'b'])
      const theirs = await service.createConversation('a', ['a', 'c'])
      const elsewhere = await service.sendMessage({
        conversationId: theirs.id,
        senderId: 'a',
        body: 'hi',
      })

      await expect(service.deleteMessage(mine.id, elsewhere.id, 'a')).rejects.toThrow(MessageNotFoundError)
    })

    it('is a no-op the second time, keeping the original deletion time', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      const sent = await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' })

      const first = await service.deleteMessage(conversation.id, sent.id, 'a')
      await tick()
      const second = await service.deleteMessage(conversation.id, sent.id, 'a')

      expect(second.deletedAt).toEqual(first.deletedAt)
    })

    it('publishes the tombstone so open clients can redraw it, and notifies nobody', async () => {
      const bus = new RecordingBus()
      const notifier = new RecordingNotifier()
      const withBus = new MessagingService(
        new InMemoryConversationStore(),
        new InMemoryMessageStore(),
        bus,
        undefined,
        notifier,
      )
      const conversation = await withBus.createConversation('a', ['a', 'b'])
      const sent = await withBus.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' })

      await withBus.deleteMessage(conversation.id, sent.id, 'a')

      expect(bus.published).toHaveLength(2)
      expect(bus.published[1]!.deletedAt).toBeInstanceOf(Date)
      // One notification for the send, and none for the delete: a deletion
      // is not something to push at anyone.
      expect(notifier.calls).toHaveLength(1)
    })
  })

  describe('deleteConversation', () => {
    it('hides the conversation and its history from the caller only', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' })

      await service.deleteConversation(conversation.id, 'a')

      expect(await service.listConversations('a')).toEqual([])
      await expect(service.listMessages(conversation.id, 'a')).resolves.toEqual([])

      const forB = await service.listConversations('b')
      expect(forB.map((c) => c.id)).toEqual([conversation.id])
      await expect(service.listMessages(conversation.id, 'b')).resolves.toHaveLength(1)
    })

    it('brings the conversation back when the other side sends something new', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'old' })
      await service.deleteConversation(conversation.id, 'a')
      await tick()

      await service.sendMessage({ conversationId: conversation.id, senderId: 'b', body: 'new' })

      const conversations = await service.listConversations('a')
      expect(conversations.map((c) => c.id)).toEqual([conversation.id])
      // Only what arrived after the delete: the cleared history stays gone.
      const messages = await service.listMessages(conversation.id, 'a')
      expect(messages.map((m) => m.body)).toEqual(['new'])
    })

    it('previews the conversation from what is left, not from the cleared history', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])
      await service.sendMessage({ conversationId: conversation.id, senderId: 'b', body: 'old' })
      await service.deleteConversation(conversation.id, 'a')
      await tick()
      await service.sendMessage({ conversationId: conversation.id, senderId: 'b', body: 'new' })

      const [forA] = await service.listConversations('a')
      expect(forA!.lastMessage?.body).toBe('new')
    })

    it('hides a conversation that never had any messages', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])

      await service.deleteConversation(conversation.id, 'a')

      expect(await service.listConversations('a')).toEqual([])
      expect((await service.listConversations('b')).map((c) => c.id)).toEqual([conversation.id])
    })

    it('refuses a caller who is not a participant', async () => {
      const conversation = await service.createConversation('a', ['a', 'b'])

      await expect(service.deleteConversation(conversation.id, 'c')).rejects.toThrow(NotAParticipantError)
    })

    it('rejects an unknown conversation', async () => {
      await expect(service.deleteConversation('nope', 'a')).rejects.toThrow(ConversationNotFoundError)
    })
  })
})
