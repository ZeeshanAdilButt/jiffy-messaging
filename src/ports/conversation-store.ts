import type { Conversation } from '../domain/index.js'

export interface ConversationStore {
  create(participantIds: string[]): Promise<Conversation>
  findById(id: string): Promise<Conversation | null>
  findByParticipant(userId: string): Promise<Conversation[]>
  markRead(conversationId: string, userId: string, at: Date): Promise<void>
}
