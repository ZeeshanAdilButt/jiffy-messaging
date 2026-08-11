import { describe, expect, it } from 'vitest'

import { rowToMessage, rowsToConversations } from './rows.js'

describe('rowToMessage', () => {
  it('maps snake_case columns to the domain shape', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const message = rowToMessage({
      id: 'm1',
      conversation_id: 'c1',
      sender_id: 'a',
      body: 'hi',
      created_at: createdAt,
    })

    expect(message).toEqual({
      id: 'm1',
      conversationId: 'c1',
      senderId: 'a',
      body: 'hi',
      createdAt,
    })
  })
})

describe('rowsToConversations', () => {
  it('groups one row per participant into a single conversation', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const conversations = rowsToConversations([
      { id: 'c1', created_at: createdAt, user_id: 'a', last_read_at: null },
      { id: 'c1', created_at: createdAt, user_id: 'b', last_read_at: null },
    ])

    expect(conversations).toEqual([
      {
        id: 'c1',
        createdAt,
        participants: [
          { userId: 'a', lastReadAt: null },
          { userId: 'b', lastReadAt: null },
        ],
      },
    ])
  })

  it('keeps separate conversations separate, in first-seen order', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const conversations = rowsToConversations([
      { id: 'c2', created_at: createdAt, user_id: 'b', last_read_at: null },
      { id: 'c1', created_at: createdAt, user_id: 'a', last_read_at: null },
      { id: 'c2', created_at: createdAt, user_id: 'c', last_read_at: null },
    ])

    expect(conversations.map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(conversations[0]!.participants.map((p) => p.userId)).toEqual(['b', 'c'])
  })

  it('returns an empty array for no rows', () => {
    expect(rowsToConversations([])).toEqual([])
  })

  it('preserves a non-null lastReadAt', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const lastReadAt = new Date('2026-01-02T00:00:00Z')
    const conversations = rowsToConversations([{ id: 'c1', created_at: createdAt, user_id: 'a', last_read_at: lastReadAt }])

    expect(conversations[0]!.participants[0]!.lastReadAt).toEqual(lastReadAt)
  })
})
