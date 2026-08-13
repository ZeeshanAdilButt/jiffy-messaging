import { isParticipant, type Conversation, type Message } from '../domain/index.js'
import type {
  ConversationGate,
  ConversationStore,
  ListMessagesOptions,
  MessageBus,
  MessageStore,
} from '../ports/index.js'
import {
  ConversationNotAllowedError,
  ConversationNotFoundError,
  EmptyMessageError,
  NotAParticipantError,
} from './errors.js'

export interface SendMessageInput {
  conversationId: string
  senderId: string
  body: string
}

const NOOP_MESSAGE_BUS: MessageBus = {
  async publish() {},
  onMessage() {
    return () => {}
  },
}

// Mirrors AllowAllGate in src/adapters/conversation-gate rather than
// importing it - core stays free of any dependency on adapters, the same
// reason NOOP_MESSAGE_BUS above is inlined instead of imported.
const ALLOW_ALL_GATE: ConversationGate = {
  async canCreateConversation() {
    return true
  },
}

export class MessagingService {
  constructor(
    private readonly conversations: ConversationStore,
    private readonly messages: MessageStore,
    private readonly messageBus: MessageBus = NOOP_MESSAGE_BUS,
    private readonly gate: ConversationGate = ALLOW_ALL_GATE,
  ) {}

  async createConversation(requesterId: string, participantIds: string[]): Promise<Conversation> {
    if (!(await this.gate.canCreateConversation(requesterId, participantIds))) {
      throw new ConversationNotAllowedError(requesterId, participantIds)
    }

    return this.conversations.create(participantIds)
  }

  async getConversation(conversationId: string, requesterId: string): Promise<Conversation> {
    return this.requireParticipant(conversationId, requesterId)
  }

  async listConversations(userId: string): Promise<Conversation[]> {
    return this.conversations.findByParticipant(userId)
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    if (input.body.trim().length === 0) {
      throw new EmptyMessageError()
    }

    const conversation = await this.requireParticipant(input.conversationId, input.senderId)

    // Re-checked on every send, not just at creation - a gate whose answer
    // can change after the fact (a revoked share, a removed contact) needs
    // this to actually enforce the change. Without it, a conversation that
    // passed the gate once at creation stays usable forever regardless of
    // what happens to the relationship behind it afterward.
    const participantIds = conversation.participants.map((p) => p.userId)
    if (!(await this.gate.canCreateConversation(input.senderId, participantIds))) {
      throw new ConversationNotAllowedError(input.senderId, participantIds)
    }

    const message = await this.messages.create({
      conversationId: conversation.id,
      senderId: input.senderId,
      body: input.body,
    })

    // Real-time delivery is best-effort on top of a durable write, not part
    // of it - the message already exists once messages.create resolves, so
    // a bus failure here must not surface as a failed send.
    void this.messageBus.publish(message).catch(() => {})

    return message
  }

  async listMessages(
    conversationId: string,
    requesterId: string,
    options?: ListMessagesOptions,
  ): Promise<Message[]> {
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
