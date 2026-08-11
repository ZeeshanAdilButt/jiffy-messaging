import { describe, expect, it } from 'vitest'

import { isUnread, type Message } from './message.js'

function makeMessage(createdAt: string): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    senderId: 'a',
    body: 'hello',
    createdAt: new Date(createdAt),
  }
}

describe('isUnread', () => {
  it('is unread when never read', () => {
    const message = makeMessage('2026-01-01T00:00:00Z')
    expect(isUnread(message, null)).toBe(true)
  })

  it('is unread when sent after the last read time', () => {
    const message = makeMessage('2026-01-02T00:00:00Z')
    const lastReadAt = new Date('2026-01-01T00:00:00Z')
    expect(isUnread(message, lastReadAt)).toBe(true)
  })

  it('is read when sent before the last read time', () => {
    const message = makeMessage('2026-01-01T00:00:00Z')
    const lastReadAt = new Date('2026-01-02T00:00:00Z')
    expect(isUnread(message, lastReadAt)).toBe(false)
  })

  it('is read when sent at exactly the last read time', () => {
    const at = '2026-01-01T00:00:00Z'
    const message = makeMessage(at)
    expect(isUnread(message, new Date(at))).toBe(false)
  })
})
