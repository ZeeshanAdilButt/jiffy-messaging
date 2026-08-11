import type { Pool } from 'pg'

import type { Message } from '../../domain/index.js'
import type { ListMessagesOptions, MessageStore, NewMessage } from '../../ports/index.js'
import { firstRow, rowToMessage, type MessageRow } from './rows.js'

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

    // Without a limit, oldest-first is the natural order to return. With a
    // limit, we want the most recent N matching rows but still returned
    // oldest-first, so the inner query flips the sort to take the right
    // slice and the outer query flips it back.
    let query = `SELECT ${columns} FROM messages WHERE ${where} ORDER BY created_at ASC`

    if (options.limit !== undefined) {
      params.push(options.limit)
      query = `
        SELECT * FROM (
          SELECT ${columns} FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}
        ) recent
        ORDER BY created_at ASC
      `
    }

    const result = await this.pool.query<MessageRow>(query, params)
    return result.rows.map(rowToMessage)
  }
}
