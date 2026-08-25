import type { Conversation } from '../domain/index.js'

export interface ConversationStore {
  create(participantIds: string[]): Promise<Conversation>
  findById(id: string): Promise<Conversation | null>
  findByParticipant(userId: string): Promise<Conversation[]>
  markRead(conversationId: string, userId: string, at: Date): Promise<void>
  /**
   * Marks the conversation deleted for this one participant, as of `at`.
   * Nothing is removed: see ConversationParticipant.clearedAt for what the
   * instant means and why it is per participant.
   */
  clear(conversationId: string, userId: string, at: Date): Promise<void>
}
