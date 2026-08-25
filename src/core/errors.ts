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

export class MessageNotFoundError extends Error {
  constructor(messageId: string) {
    super(`Message not found: ${messageId}`)
    this.name = 'MessageNotFoundError'
  }
}

/**
 * Raised when someone tries to delete a message they did not send. Deleting
 * for everyone is the sender's call and nobody else's, including the other
 * participants in the conversation - see MessagingService.deleteMessage.
 */
export class NotMessageAuthorError extends Error {
  constructor(messageId: string, userId: string) {
    super(`User ${userId} did not send message ${messageId}`)
    this.name = 'NotMessageAuthorError'
  }
}
