import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { PostgresMessageStore } from './message-store.js'

class FakePool {
  queries: { text: string; params?: unknown[] }[] = []

  constructor(private readonly results: Array<{ rows: unknown[] }> = []) {}

  async query(text: string, params?: unknown[]) {
    this.queries.push({ text, params })
    return this.results.shift() ?? { rows: [] }
  }
}

describe('PostgresMessageStore', () => {
  describe('create', () => {
    it('inserts with the given fields and returns the mapped row', async () => {
      const createdAt = new Date('2026-01-01T00:00:00Z')
      const pool = new FakePool([
        { rows: [{ id: 'm1', conversation_id: 'c1', sender_id: 'a', body: 'hi', created_at: createdAt }] },
      ])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      const message = await store.create({ conversationId: 'c1', senderId: 'a', body: 'hi' })

      expect(message).toEqual({ id: 'm1', conversationId: 'c1', senderId: 'a', body: 'hi', createdAt })
      expect(pool.queries[0]!.params).toEqual(['c1', 'a', 'hi'])
    })
  })

  describe('listByConversation', () => {
    it('filters by conversation id only when no options are given', async () => {
      const pool = new FakePool([{ rows: [] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      await store.listByConversation('c1')

      expect(pool.queries[0]!.params).toEqual(['c1'])
      expect(pool.queries[0]!.text).not.toContain('LIMIT')
    })

    it('adds before and limit as positional parameters in the order given', async () => {
      const pool = new FakePool([{ rows: [] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)
      const before = new Date('2026-01-01T00:00:00Z')

      await store.listByConversation('c1', { before, limit: 5 })

      expect(pool.queries[0]!.params).toEqual(['c1', before, 5])
      expect(pool.queries[0]!.text).toContain('LIMIT $3')
    })

    it('maps returned rows to messages', async () => {
      const createdAt = new Date('2026-01-01T00:00:00Z')
      const pool = new FakePool([
        { rows: [{ id: 'm1', conversation_id: 'c1', sender_id: 'a', body: 'hi', created_at: createdAt }] },
      ])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      const messages = await store.listByConversation('c1')
      expect(messages).toEqual([{ id: 'm1', conversationId: 'c1', senderId: 'a', body: 'hi', createdAt }])
    })
  })
})
