import type { Message } from '../domain/index.js'

export interface NewMessage {
  conversationId: string
  senderId: string
  body: string
}

export interface ListMessagesOptions {
  limit?: number
  before?: Date
}

export interface MessageStore {
  create(message: NewMessage): Promise<Message>
  listByConversation(conversationId: string, options?: ListMessagesOptions): Promise<Message[]>
}
