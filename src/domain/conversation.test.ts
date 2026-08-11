import { describe, expect, it } from 'vitest'

import { isParticipant, otherParticipants, type Conversation } from './conversation.js'

function makeConversation(userIds: string[]): Conversation {
  return {
    id: 'c1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    participants: userIds.map((userId) => ({ userId, lastReadAt: null })),
  }
}

describe('isParticipant', () => {
  it('is true for someone in the conversation', () => {
    const conversation = makeConversation(['a', 'b'])
    expect(isParticipant(conversation, 'a')).toBe(true)
  })

  it('is false for someone not in the conversation', () => {
    const conversation = makeConversation(['a', 'b'])
    expect(isParticipant(conversation, 'c')).toBe(false)
  })
})

describe('otherParticipants', () => {
  it('excludes the given user', () => {
    const conversation = makeConversation(['a', 'b', 'c'])
    const others = otherParticipants(conversation, 'a')
    expect(others.map((p) => p.userId)).toEqual(['b', 'c'])
  })

  it('returns everyone when the given user is not a participant', () => {
    const conversation = makeConversation(['a', 'b'])
    const others = otherParticipants(conversation, 'z')
    expect(others.map((p) => p.userId)).toEqual(['a', 'b'])
  })
})
