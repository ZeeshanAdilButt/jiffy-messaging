import { isParticipant, type Conversation } from '../../domain/index.js'
import type { ConversationStore } from '../../ports/index.js'

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>()

  async create(participantIds: string[]): Promise<Conversation> {
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      participants: participantIds.map((userId) => ({ userId, lastReadAt: null })),
      createdAt: new Date(),
    }
    this.conversations.set(conversation.id, conversation)
    return conversation
  }

  async findById(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null
  }

  async findByParticipant(userId: string): Promise<Conversation[]> {
    return [...this.conversations.values()].filter((conversation) => isParticipant(conversation, userId))
  }

  async markRead(conversationId: string, userId: string, at: Date): Promise<void> {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return

    const participant = conversation.participants.find((p) => p.userId === userId)
    if (!participant) return

    participant.lastReadAt = at
  }
}
