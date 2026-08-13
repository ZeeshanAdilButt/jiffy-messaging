export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation not found: ${conversationId}`)
    this.name = 'ConversationNotFoundError'
  }
}

export class NotAParticipantError extends Error {
  constructor(conversationId: string, userId: string) {
    super(`User ${userId} is not a participant in conversation ${conversationId}`)
    this.name = 'NotAParticipantError'
  }
}

export class EmptyMessageError extends Error {
  constructor() {
    super('Message body cannot be empty')
    this.name = 'EmptyMessageError'
  }
}

export class ConversationNotAllowedError extends Error {
  constructor(requesterId: string, participantIds: string[]) {
    const others = participantIds.filter((id) => id !== requesterId)
    super(`User ${requesterId} is not allowed to be in a conversation with ${others.join(', ')}`)
    this.name = 'ConversationNotAllowedError'
  }
}
