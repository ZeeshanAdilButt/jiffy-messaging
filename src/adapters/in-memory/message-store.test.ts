import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InMemoryMessageStore } from './message-store.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('InMemoryMessageStore', () => {
  it('creates a message for a conversation', async () => {
    const store = new InMemoryMessageStore()
    const message = await store.create({ conversationId: 'c1', senderId: 'a', body: 'hi' })

    expect(message).toMatchObject({ conversationId: 'c1', senderId: 'a', body: 'hi' })
    expect(message.id).toBeTruthy()
    expect(message.createdAt).toBeInstanceOf(Date)
  })

  it('lists messages for a conversation in chronological order', async () => {
    const store = new InMemoryMessageStore()
    await store.create({ conversationId: 'c1', senderId: 'a', body: 'first' })
    vi.advanceTimersByTime(1000)
    await store.create({ conversationId: 'c2', senderId: 'b', body: 'other conversation' })
    vi.advanceTimersByTime(1000)
    await store.create({ conversationId: 'c1', senderId: 'b', body: 'second' })

    const messages = await store.listByConversation('c1')
    expect(messages.map((m) => m.body)).toEqual(['first', 'second'])
  })

  it('limits results to the most recent messages', async () => {
    const store = new InMemoryMessageStore()
    await store.create({ conversationId: 'c1', senderId: 'a', body: 'one' })
    vi.advanceTimersByTime(1000)
    await store.create({ conversationId: 'c1', senderId: 'a', body: 'two' })
    vi.advanceTimersByTime(1000)
    await store.create({ conversationId: 'c1', senderId: 'a', body: 'three' })

    const messages = await store.listByConversation('c1', { limit: 2 })
    expect(messages.map((m) => m.body)).toEqual(['two', 'three'])
  })

  it('excludes messages at or after the before cursor', async () => {
    const store = new InMemoryMessageStore()
    const first = await store.create({ conversationId: 'c1', senderId: 'a', body: 'first' })
    vi.advanceTimersByTime(1000)
    await store.create({ conversationId: 'c1', senderId: 'a', body: 'second' })

    const cutoff = new Date(first.createdAt.getTime() + 1)
    const messages = await store.listByConversation('c1', { before: first.createdAt })
    expect(messages).toEqual([])

    const messagesUpToCutoff = await store.listByConversation('c1', { before: cutoff })
    expect(messagesUpToCutoff.map((m) => m.body)).toEqual(['first'])
  })

  describe('softDelete', () => {
    it('keeps the row, empties the body, and stamps deletedAt', async () => {
      const store = new InMemoryMessageStore()
      const created = await store.create({ conversationId: 'c1', senderId: 'a', body: 'oops' })
      const at = new Date('2026-01-02T00:00:00Z')

      const deleted = await store.softDelete(created.id, at)

      expect(deleted.body).toBe('')
      expect(deleted.deletedAt).toEqual(at)
      await expect(store.listByConversation('c1')).resolves.toHaveLength(1)
    })

    it('leaves an already-deleted message where it is', async () => {
      const store = new InMemoryMessageStore()
      const created = await store.create({ conversationId: 'c1', senderId: 'a', body: 'oops' })
      const first = new Date('2026-01-02T00:00:00Z')
      await store.softDelete(created.id, first)

      const again = await store.softDelete(created.id, new Date('2026-01-03T00:00:00Z'))

      expect(again.deletedAt).toEqual(first)
    })
  })

  describe('after', () => {
    it('returns only messages created strictly after the instant', async () => {
      const store = new InMemoryMessageStore()
      const older = await store.create({ conversationId: 'c1', senderId: 'a', body: 'old' })
      vi.advanceTimersByTime(1000)
      const newer = await store.create({ conversationId: 'c1', senderId: 'a', body: 'new' })

      const results = await store.listByConversation('c1', { after: older.createdAt })

      expect(results.map((message) => message.id)).toEqual([newer.id])
    })
  })
})
