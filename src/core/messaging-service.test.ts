import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryConversationStore, InMemoryMessageStore } from '../adapters/in-memory/index.js'
import { ConversationNotFoundError, EmptyMessageError, MessagingService, NotAParticipantError } from './index.js'

describe('MessagingService', () => {
  let service: MessagingService

  beforeEach(() => {
    service = new MessagingService(new InMemoryConversationStore(), new InMemoryMessageStore())
  })

  describe('createConversation', () => {
    it('creates a conversation with the given participants', async () => {
      const conversation = await service.createConversation(['a', 'b'])
      expect(conversation.participants.map((p) => p.userId)).toEqual(['a', 'b'])
    })
  })

  describe('sendMessage', () => {
    it('sends a message from a participant', async () => {
      const conversation = await service.createConversation(['a', 'b'])
      const message = await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' })
      expect(message).toMatchObject({ conversationId: conversation.id, senderId: 'a', body: 'hi' })
    })

    it('rejects an empty body', async () => {
      const conversation = await service.createConversation(['a', 'b'])
      await expect(
        service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: '   ' }),
      ).rejects.toThrow(EmptyMessageError)
    })

    it('rejects a sender who is not a participant', async () => {
      const conversation = await service.createConversation(['a', 'b'])
      await expect(
        service.sendMessage({ conversationId: conversation.id, senderId: 'z', body: 'hi' }),
      ).rejects.toThrow(NotAParticipantError)
    })

    it('rejects an unknown conversation', async () => {
      await expect(service.sendMessage({ conversationId: 'missing', senderId: 'a', body: 'hi' })).rejects.toThrow(
        ConversationNotFoundError,
      )
    })
  })

  describe('listMessages', () => {
    it('lists messages for a participant', async () => {
      const conversation = await service.createConversation(['a', 'b'])
      await service.sendMessage({ conversationId: conversation.id, senderId: 'a', body: 'hi' })

      const messages = await service.listMessages(conversation.id, 'b')
      expect(messages.map((m) => m.body)).toEqual(['hi'])
    })

    it('rejects a requester who is not a participant', async () => {
      const conversation = await service.createConversation(['a', 'b'])
      await expect(service.listMessages(conversation.id, 'z')).rejects.toThrow(NotAParticipantError)
    })
  })

  describe('markRead', () => {
    it('records when a participant read the conversation', async () => {
      const conversation = await service.createConversation(['a', 'b'])
      const readAt = new Date('2026-01-01T00:00:00Z')

      await service.markRead(conversation.id, 'a', readAt)

      const updated = await service.getConversation(conversation.id, 'a')
      expect(updated.participants.find((p) => p.userId === 'a')?.lastReadAt).toEqual(readAt)
    })

    it('rejects a non participant', async () => {
      const conversation = await service.createConversation(['a', 'b'])
      await expect(service.markRead(conversation.id, 'z', new Date())).rejects.toThrow(NotAParticipantError)
    })
  })
})
