import type { Message } from '../domain/index.js'

export interface NewMessage {
  conversationId: string
  senderId: string
  body: string
}

export interface ListMessagesOptions {
  limit?: number
  before?: Date
  /**
   * Returns only messages created strictly after this instant. Set from
   * the requester's own `clearedAt` (see ConversationParticipant), which
   * is what makes deleting a conversation hide the history behind it for
   * that one participant without touching anyone else's view of it.
   */
  after?: Date
}

export interface MessageStore {
  create(message: NewMessage): Promise<Message>
  findById(id: string): Promise<Message | null>
  listByConversation(conversationId: string, options?: ListMessagesOptions): Promise<Message[]>
  /**
   * Tombstones a message: sets deletedAt and empties the body, keeping the
   * row. Returns the message as it now stands. Implementations must leave
   * an already-deleted message alone and return it unchanged rather than
   * moving its deletedAt, so a repeated delete is a no-op.
   *
   * Deliberately not `delete`. Removing the row is not an option this port
   * offers, because the other participant has already read the message and
   * a thread that silently loses rows is worse than one that admits a
   * message was deleted.
   */
  softDelete(id: string, at: Date): Promise<Message>
}
