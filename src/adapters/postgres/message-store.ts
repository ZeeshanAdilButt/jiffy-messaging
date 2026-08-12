import type { Pool } from 'pg'

import type { Message } from '../../domain/index.js'
import type { ListMessagesOptions, MessageStore, NewMessage } from '../../ports/index.js'
import { firstRow, rowToMessage, type MessageRow } from './rows.js'

/** Applied when a caller asks for history with no limit at all. */
const DEFAULT_LIMIT = 50

/**
 * Hard ceiling on any limit, including a caller-supplied one. Without
 * this, GET /conversations/:id/messages?limit=1000000 dumps a
 * conversation's entire history in one response, and no limit at all
 * (the default-limit case above) is the same problem with an even lower
 * bar to trigger it.
 */
const MAX_LIMIT = 200

export class PostgresMessageStore implements MessageStore {
  constructor(private readonly pool: Pool) {}

  async create(input: NewMessage): Promise<Message> {
    const result = await this.pool.query<MessageRow>(
      `INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, conversation_id, sender_id, body, created_at`,
      [input.conversationId, input.senderId, input.body],
    )
    return rowToMessage(firstRow(result.rows))
  }

  async listByConversation(conversationId: string, options: ListMessagesOptions = {}): Promise<Message[]> {
    const params: unknown[] = [conversationId]
    let where = 'conversation_id = $1'

    if (options.before) {
      params.push(options.before)
      where += ` AND created_at < $${params.length}`
    }

    const columns = 'id, conversation_id, sender_id, body, created_at'

    // Every call is bounded, whether the caller asked for a limit or not:
    // no limit at all falls back to DEFAULT_LIMIT, and any limit the
    // caller does supply is clamped to MAX_LIMIT. We want the most recent
    // N matching rows but still returned oldest-first, so the inner query
    // flips the sort to take the right slice and the outer query flips it
    // back.
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    params.push(limit)
    const query = `
      SELECT * FROM (
        SELECT ${columns} FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}
      ) recent
      ORDER BY created_at ASC
    `

    const result = await this.pool.query<MessageRow>(query, params)
    return result.rows.map(rowToMessage)
  }
}
