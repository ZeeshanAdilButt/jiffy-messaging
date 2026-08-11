import type { Pool } from 'pg'

import type { Conversation } from '../../domain/index.js'
import type { ConversationStore } from '../../ports/index.js'
import { firstRow, rowsToConversations, type ConversationParticipantRow } from './rows.js'

const SELECT_WITH_PARTICIPANTS = `
  SELECT c.id, c.created_at, p.user_id, p.last_read_at
  FROM conversations c
  JOIN conversation_participants p ON p.conversation_id = c.id
`

export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly pool: Pool) {}

  async create(participantIds: string[]): Promise<Conversation> {
    const client = await this.pool.connect()

    try {
      await client.query('BEGIN')

      const inserted = await client.query<{ id: string; created_at: Date }>(
        'INSERT INTO conversations DEFAULT VALUES RETURNING id, created_at',
      )
      const { id, created_at: createdAt } = firstRow(inserted.rows)

      for (const userId of participantIds) {
        await client.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)', [
          id,
          userId,
        ])
      }

      await client.query('COMMIT')

      return {
        id,
        createdAt,
        participants: participantIds.map((userId) => ({ userId, lastReadAt: null })),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async findById(id: string): Promise<Conversation | null> {
    const result = await this.pool.query<ConversationParticipantRow>(`${SELECT_WITH_PARTICIPANTS} WHERE c.id = $1`, [
      id,
    ])
    return rowsToConversations(result.rows)[0] ?? null
  }

  async findByParticipant(userId: string): Promise<Conversation[]> {
    const result = await this.pool.query<ConversationParticipantRow>(
      `${SELECT_WITH_PARTICIPANTS}
       WHERE c.id IN (SELECT conversation_id FROM conversation_participants WHERE user_id = $1)
       ORDER BY c.created_at ASC`,
      [userId],
    )
    return rowsToConversations(result.rows)
  }

  async markRead(conversationId: string, userId: string, at: Date): Promise<void> {
    await this.pool.query(
      'UPDATE conversation_participants SET last_read_at = $1 WHERE conversation_id = $2 AND user_id = $3',
      [at, conversationId, userId],
    )
  }
}
