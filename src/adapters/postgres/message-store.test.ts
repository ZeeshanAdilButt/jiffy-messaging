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

  describe('findById', () => {
    it('returns null when nothing matches', async () => {
      const pool = new FakePool([{ rows: [] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      await expect(store.findById('m1')).resolves.toBeNull()
      expect(pool.queries[0]!.params).toEqual(['m1'])
    })

    it('maps the row, deleted_at included', async () => {
      const createdAt = new Date('2026-01-01T00:00:00Z')
      const deletedAt = new Date('2026-01-02T00:00:00Z')
      const pool = new FakePool([
        {
          rows: [
            {
              id: 'm1',
              conversation_id: 'c1',
              sender_id: 'a',
              body: '',
              created_at: createdAt,
              deleted_at: deletedAt,
            },
          ],
        },
      ])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      await expect(store.findById('m1')).resolves.toEqual({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'a',
        body: '',
        createdAt,
        deletedAt,
      })
    })
  })

  describe('softDelete', () => {
    it('empties the body in the same statement that sets deleted_at', async () => {
      const at = new Date('2026-01-02T00:00:00Z')
      const pool = new FakePool([
        {
          rows: [
            {
              id: 'm1',
              conversation_id: 'c1',
              sender_id: 'a',
              body: '',
              created_at: new Date('2026-01-01T00:00:00Z'),
              deleted_at: at,
            },
          ],
        },
      ])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      const message = await store.softDelete('m1', at)

      expect(message.body).toBe('')
      expect(message.deletedAt).toEqual(at)
      expect(pool.queries[0]!.text).toContain("SET body = ''")
      expect(pool.queries[0]!.text).toContain('deleted_at IS NULL')
      expect(pool.queries[0]!.params).toEqual(['m1', at])
    })

    it('never removes the row', async () => {
      const pool = new FakePool([{ rows: [{ id: 'm1', conversation_id: 'c1', sender_id: 'a', body: '', created_at: new Date(), deleted_at: new Date() }] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      await store.softDelete('m1', new Date())

      expect(pool.queries[0]!.text).not.toContain('DELETE')
    })

    it('falls back to the existing tombstone when the update matched nothing', async () => {
      const deletedAt = new Date('2026-01-02T00:00:00Z')
      const pool = new FakePool([
        // The UPDATE ... WHERE deleted_at IS NULL matched no row, which is
        // what a second delete of the same message looks like.
        { rows: [] },
        {
          rows: [
            {
              id: 'm1',
              conversation_id: 'c1',
              sender_id: 'a',
              body: '',
              created_at: new Date('2026-01-01T00:00:00Z'),
              deleted_at: deletedAt,
            },
          ],
        },
      ])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      const message = await store.softDelete('m1', new Date('2026-01-03T00:00:00Z'))

      expect(message.deletedAt).toEqual(deletedAt)
    })
  })

  describe('listByConversation', () => {
    it('applies a default limit when no options are given', async () => {
      const pool = new FakePool([{ rows: [] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      await store.listByConversation('c1')

      expect(pool.queries[0]!.params).toEqual(['c1', 50])
      expect(pool.queries[0]!.text).toContain('LIMIT $2')
    })

    it('adds before and limit as positional parameters in the order given', async () => {
      const pool = new FakePool([{ rows: [] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)
      const before = new Date('2026-01-01T00:00:00Z')

      await store.listByConversation('c1', { before, limit: 5 })

      expect(pool.queries[0]!.params).toEqual(['c1', before, 5])
      expect(pool.queries[0]!.text).toContain('LIMIT $3')
    })

    it('adds after as its own positional parameter', async () => {
      const pool = new FakePool([{ rows: [] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)
      const after = new Date('2026-01-01T00:00:00Z')

      await store.listByConversation('c1', { after })

      expect(pool.queries[0]!.params).toEqual(['c1', after, 50])
      expect(pool.queries[0]!.text).toContain('created_at > $2')
    })

    it('applies before and after together', async () => {
      const pool = new FakePool([{ rows: [] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)
      const before = new Date('2026-02-01T00:00:00Z')
      const after = new Date('2026-01-01T00:00:00Z')

      await store.listByConversation('c1', { before, after, limit: 5 })

      expect(pool.queries[0]!.params).toEqual(['c1', before, after, 5])
      expect(pool.queries[0]!.text).toContain('created_at < $2')
      expect(pool.queries[0]!.text).toContain('created_at > $3')
    })

    it('clamps a caller-supplied limit above the maximum down to the maximum', async () => {
      const pool = new FakePool([{ rows: [] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      await store.listByConversation('c1', { limit: 1_000_000 })

      expect(pool.queries[0]!.params).toEqual(['c1', 200])
    })

    it('never emits a query with no LIMIT clause at all', async () => {
      const pool = new FakePool([{ rows: [] }])
      const store = new PostgresMessageStore(pool as unknown as Pool)

      await store.listByConversation('c1')

      expect(pool.queries[0]!.text).toContain('LIMIT')
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
