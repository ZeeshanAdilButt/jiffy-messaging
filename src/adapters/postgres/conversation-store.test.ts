import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { PostgresConversationStore } from './conversation-store.js'

// These exercise query construction and row mapping against a fake pg
// client, not a real database - that comes later with the integration
// tests phase. A fake is enough to pin down parameter order and the
// BEGIN/COMMIT/ROLLBACK shape of the create transaction.
class FakeClient {
  queries: { text: string; params?: unknown[] }[] = []

  constructor(private readonly results: Array<{ rows: unknown[] }>) {}

  async query(text: string, params?: unknown[]) {
    this.queries.push({ text, params })
    const trimmed = text.trim()
    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      return { rows: [] }
    }
    return this.results.shift() ?? { rows: [] }
  }

  release() {}
}

class FakePool {
  queries: { text: string; params?: unknown[] }[] = []

  constructor(
    private readonly client: FakeClient,
    private readonly queryResults: Array<{ rows: unknown[] }> = [],
  ) {}

  async connect() {
    return this.client
  }

  async query(text: string, params?: unknown[]) {
    this.queries.push({ text, params })
    return this.queryResults.shift() ?? { rows: [] }
  }
}

describe('PostgresConversationStore', () => {
  describe('create', () => {
    it('inserts the conversation and each participant inside one transaction', async () => {
      const createdAt = new Date('2026-01-01T00:00:00Z')
      const client = new FakeClient([{ rows: [{ id: 'c1', created_at: createdAt }] }, { rows: [] }, { rows: [] }])
      const pool = new FakePool(client)
      const store = new PostgresConversationStore(pool as unknown as Pool)

      const conversation = await store.create(['a', 'b'])

      expect(conversation).toEqual({
        id: 'c1',
        createdAt,
        participants: [
          { userId: 'a', lastReadAt: null },
          { userId: 'b', lastReadAt: null },
        ],
      })

      const statements = client.queries.map((q) => q.text.trim())
      expect(statements[0]).toBe('BEGIN')
      expect(statements[statements.length - 1]).toBe('COMMIT')
      expect(client.queries[2]!.params).toEqual(['c1', 'a'])
      expect(client.queries[3]!.params).toEqual(['c1', 'b'])
    })

    it('rolls back and rethrows when a participant insert fails', async () => {
      const client = new FakeClient([{ rows: [{ id: 'c1', created_at: new Date() }] }])
      client.query = async (text: string, params?: unknown[]) => {
        client.queries.push({ text, params })
        const trimmed = text.trim()
        if (trimmed === 'BEGIN' || trimmed === 'ROLLBACK') return { rows: [] }
        if (trimmed.startsWith('INSERT INTO conversation_participants')) throw new Error('constraint violation')
        return { rows: [{ id: 'c1', created_at: new Date() }] }
      }
      const pool = new FakePool(client)
      const store = new PostgresConversationStore(pool as unknown as Pool)

      await expect(store.create(['a'])).rejects.toThrow('constraint violation')
      expect(client.queries.map((q) => q.text.trim())).toContain('ROLLBACK')
    })
  })

  describe('findById', () => {
    it('returns null when no rows match', async () => {
      const pool = new FakePool(new FakeClient([]), [{ rows: [] }])
      const store = new PostgresConversationStore(pool as unknown as Pool)

      await expect(store.findById('missing')).resolves.toBeNull()
    })

    it('maps joined rows into one conversation', async () => {
      const createdAt = new Date('2026-01-01T00:00:00Z')
      const pool = new FakePool(new FakeClient([]), [
        {
          rows: [
            { id: 'c1', created_at: createdAt, user_id: 'a', last_read_at: null },
            { id: 'c1', created_at: createdAt, user_id: 'b', last_read_at: null },
          ],
        },
      ])
      const store = new PostgresConversationStore(pool as unknown as Pool)

      const conversation = await store.findById('c1')
      expect(conversation?.participants.map((p) => p.userId)).toEqual(['a', 'b'])
    })
  })

  describe('markRead', () => {
    it('updates the matching participant row with the given timestamp', async () => {
      const pool = new FakePool(new FakeClient([]), [{ rows: [] }])
      const store = new PostgresConversationStore(pool as unknown as Pool)
      const at = new Date('2026-01-01T00:00:00Z')

      await store.markRead('c1', 'a', at)

      expect(pool.queries[0]!.params).toEqual([at, 'c1', 'a'])
    })
  })
})
