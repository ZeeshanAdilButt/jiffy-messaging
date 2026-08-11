import type { Conversation, Message } from '../../domain/index.js'

export interface ConversationParticipantRow {
  id: string
  created_at: Date
  user_id: string
  last_read_at: Date | null
}

export interface MessageRow {
  id: string
  conversation_id: string
  sender_id: string
  body: string
  created_at: Date
}

/**
 * A query using RETURNING or a primary-key lookup by an id we just
 * inserted is expected to produce exactly one row. TypeScript can't know
 * that from the driver's return type, so this turns the impossible case
 * into a clear error instead of an undefined property access.
 */
export function firstRow<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) {
    throw new Error('Expected at least one row, got none')
  }
  return row
}

export function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
  }
}

/**
 * Groups joined conversation/participant rows into Conversation objects,
 * preserving the order conversations first appear in. One row per
 * participant, so a conversation with three participants arrives as three
 * rows sharing the same id and created_at.
 */
export function rowsToConversations(rows: ConversationParticipantRow[]): Conversation[] {
  const byId = new Map<string, Conversation>()

  for (const row of rows) {
    let conversation = byId.get(row.id)
    if (!conversation) {
      conversation = { id: row.id, createdAt: row.created_at, participants: [] }
      byId.set(row.id, conversation)
    }
    conversation.participants.push({ userId: row.user_id, lastReadAt: row.last_read_at })
  }

  return [...byId.values()]
}
