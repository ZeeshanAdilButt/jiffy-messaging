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
    }
    this.messages.push(message)
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

    if (options.limit !== undefined) {
      results = results.slice(-options.limit)
    }

    return results
  }
}
