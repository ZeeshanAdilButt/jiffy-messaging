export interface Message {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: Date
  /**
   * When the sender deleted this message for everyone, or null while it
   * still stands. A deleted message keeps its row, its id, its sender and
   * its place in the thread, and loses only its body - the alternative,
   * removing the row, rewrites a history the other participant already
   * read, and leaves anything that referred to it pointing at nothing.
   * Clients render a tombstone ("this message was deleted") rather than an
   * empty bubble; see isDeleted below.
   */
  deletedAt: Date | null
}

export function isDeleted(message: Message): boolean {
  return message.deletedAt !== null
}

export function isUnread(message: Message, lastReadAt: Date | null): boolean {
  if (lastReadAt === null) return true
  return message.createdAt.getTime() > lastReadAt.getTime()
}
