export interface Message {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: Date
}

export function isUnread(message: Message, lastReadAt: Date | null): boolean {
  if (lastReadAt === null) return true
  return message.createdAt.getTime() > lastReadAt.getTime()
}
