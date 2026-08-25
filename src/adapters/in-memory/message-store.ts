import type { Message } from '../../domain/index.js'
import type { ListMessagesOptions, MessageStore, NewMessage } from '../../ports/index.js'

export class InMemoryMessageStore implements MessageStore {
  private readonly messages: Message[] = []

  async create(input: NewMessage): Promise<Message> {
    const message: Message = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      senderId: input.senderId,
      body: input.body,
      createdAt: new Date(),
      deletedAt: null,
    }
    this.messages.push(message)
    return message
  }

  async findById(id: string): Promise<Message | null> {
    return this.messages.find((message) => message.id === id) ?? null
  }

  async softDelete(id: string, at: Date): Promise<Message> {
    const message = this.messages.find((candidate) => candidate.id === id)
    if (!message) throw new Error(`Message not found: ${id}`)
    // Already deleted: hand back the existing tombstone rather than moving
    // its timestamp, matching the Postgres store's WHERE deleted_at IS NULL.
    if (message.deletedAt !== null) return message

    message.body = ''
    message.deletedAt = at
    return message
  }

  async listByConversation(conversationId: string, options: ListMessagesOptions = {}): Promise<Message[]> {
    let results = this.messages
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

    if (options.before) {
      const before = options.before.getTime()
      results = results.filter((message) => message.createdAt.getTime() < before)
    }

    if (options.after) {
      const after = options.after.getTime()
      results = results.filter((message) => message.createdAt.getTime() > after)
    }

    if (options.limit !== undefined) {
      results = results.slice(-options.limit)
    }

    return results
  }
}
