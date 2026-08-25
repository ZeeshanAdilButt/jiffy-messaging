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

/** Every read of a message row goes through this list, so a column added
 * to the table is added in one place rather than four. */
const COLUMNS = 'id, conversation_id, sender_id, body, created_at, deleted_at'

export class PostgresMessageStore implements MessageStore {
  constructor(private readonly pool: Pool) {}

  async create(input: NewMessage): Promise<Message> {
    const result = await this.pool.query<MessageRow>(
      `INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [input.conversationId, input.senderId, input.body],
    )
    return rowToMessage(firstRow(result.rows))
  }

  async findById(id: string): Promise<Message | null> {
    const result = await this.pool.query<MessageRow>(`SELECT ${COLUMNS} FROM messages WHERE id = $1`, [id])
    const row = result.rows[0]
    return row ? rowToMessage(row) : null
  }

  /**
   * The body is emptied in the same statement that sets deleted_at: a
   * "deleted" message whose text is still sitting in the table is not
   * deleted, it is hidden, and the next person to run a query would find
   * it. The row itself stays - see Message.deletedAt.
   *
   * `WHERE deleted_at IS NULL` makes a repeat call a no-op rather than a
   * second deletion that moves the timestamp, and the second SELECT is
   * what lets an already-deleted message still come back as its existing
   * tombstone instead of nothing.
   */
  async softDelete(id: string, at: Date): Promise<Message> {
    const updated = await this.pool.query<MessageRow>(
      `UPDATE messages SET body = '', deleted_at = $2
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING ${COLUMNS}`,
      [id, at],
    )

    const row = updated.rows[0]
    if (row) return rowToMessage(row)

    const existing = await this.pool.query<MessageRow>(`SELECT ${COLUMNS} FROM messages WHERE id = $1`, [id])
    return rowToMessage(firstRow(existing.rows))
  }

  async listByConversation(conversationId: string, options: ListMessagesOptions = {}): Promise<Message[]> {
    const params: unknown[] = [conversationId]
    let where = 'conversation_id = $1'

    if (options.before) {
      params.push(options.before)
      where += ` AND created_at < $${params.length}`
    }

    // The requester cleared this conversation at some point, so everything
    // up to that instant is not theirs to read any more. Applied here, in
    // the same WHERE the paging cursor uses, so it also bounds what the
    // limit is counted against - a cleared thread cannot come back as a
    // page of blank rows.
    if (options.after) {
      params.push(options.after)
      where += ` AND created_at > $${params.length}`
    }

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
        SELECT ${COLUMNS} FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}
      ) recent
      ORDER BY created_at ASC
    `

    const result = await this.pool.query<MessageRow>(query, params)
    return result.rows.map(rowToMessage)
  }
}
