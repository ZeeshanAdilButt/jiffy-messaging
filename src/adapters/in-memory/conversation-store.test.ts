import { describe, expect, it } from 'vitest'

import { InMemoryConversationStore } from './conversation-store.js'

describe('InMemoryConversationStore', () => {
  it('creates a conversation with the given participants unread', async () => {
    const store = new InMemoryConversationStore()
    const conversation = await store.create(['a', 'b'])

    expect(conversation.participants).toEqual([
      { userId: 'a', lastReadAt: null },
      { userId: 'b', lastReadAt: null },
    ])
  })

  it('finds a conversation by id', async () => {
    const store = new InMemoryConversationStore()
    const created = await store.create(['a', 'b'])

    await expect(store.findById(created.id)).resolves.toEqual(created)
  })

  it('returns null for an unknown id', async () => {
    const store = new InMemoryConversationStore()
    await expect(store.findById('missing')).resolves.toBeNull()
  })

  it('finds conversations by participant', async () => {
    const store = new InMemoryConversationStore()
    const withA = await store.create(['a', 'b'])
    await store.create(['b', 'c'])

    const found = await store.findByParticipant('a')
    expect(found).toEqual([withA])
  })

  it('marks a participant as having read at a given time', async () => {
    const store = new InMemoryConversationStore()
    const conversation = await store.create(['a', 'b'])
    const readAt = new Date('2026-01-01T00:00:00Z')

    await store.markRead(conversation.id, 'a', readAt)

    const updated = await store.findById(conversation.id)
    expect(updated?.participants.find((p) => p.userId === 'a')?.lastReadAt).toEqual(readAt)
    expect(updated?.participants.find((p) => p.userId === 'b')?.lastReadAt).toBeNull()
  })

  it('does nothing when marking read for an unknown conversation or participant', async () => {
    const store = new InMemoryConversationStore()
    const conversation = await store.create(['a'])

    await expect(store.markRead('missing', 'a', new Date())).resolves.toBeUndefined()
    await expect(store.markRead(conversation.id, 'z', new Date())).resolves.toBeUndefined()
  })
})
