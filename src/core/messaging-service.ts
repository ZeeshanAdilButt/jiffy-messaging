import { isParticipant, type Conversation, type Message } from '../domain/index.js'
import type { ConversationStore, ListMessagesOptions, MessageStore } from '../ports/index.js'
import { ConversationNotFoundError, EmptyMessageError, NotAParticipantError } from './errors.js'

export interface SendMessageInput {
  conversationId: string
  senderId: string
  body: string
}

export class MessagingService {
  constructor(
    private readonly conversations: ConversationStore,
    private readonly messages: MessageStore,
  ) {}

  async createConversation(participantIds: string[]): Promise<Conversation> {
    return this.conversations.create(participantIds)
  }

  async getConversation(conversationId: string, requesterId: string): Promise<Conversation> {
    return this.requireParticipant(conversationId, requesterId)
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    if (input.body.trim().length === 0) {
      throw new EmptyMessageError()
    }

    const conversation = await this.requireParticipant(input.conversationId, input.senderId)

    return this.messages.create({
      conversationId: conversation.id,
      senderId: input.senderId,
      body: input.body,
    })
  }

  async listMessages(conversationId: string, requesterId: string, options?: ListMessagesOptions): Promise<Message[]> {
    await this.requireParticipant(conversationId, requesterId)
    return this.messages.listByConversation(conversationId, options)
  }

  async markRead(conversationId: string, userId: string, at: Date): Promise<void> {
    await this.requireParticipant(conversationId, userId)
    await this.conversations.markRead(conversationId, userId, at)
  }

  private async requireParticipant(conversationId: string, userId: string): Promise<Conversation> {
    const conversation = await this.conversations.findById(conversationId)
    if (!conversation) {
      throw new ConversationNotFoundError(conversationId)
    }

    if (!isParticipant(conversation, userId)) {
      throw new NotAParticipantError(conversationId, userId)
    }

    return conversation
  }
}
