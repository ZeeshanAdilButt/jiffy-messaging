import { isParticipant, participantOf, type Conversation, type Message } from '../domain/index.js'
import type {
  ConversationGate,
  ConversationStore,
  ListMessagesOptions,
  MessageBus,
  MessageNotifier,
  MessageStore,
} from '../ports/index.js'
import {
  ConversationNotAllowedError,
  ConversationNotFoundError,
  EmptyMessageError,
  MessageNotFoundError,
  NotAParticipantError,
  NotMessageAuthorError,
} from './errors.js'

export interface SendMessageInput {
  conversationId: string
  senderId: string
  body: string
}

const NOOP_MESSAGE_BUS: MessageBus = {
  async publish() {},
  onMessage() {
    return () => {}
  },
}

// Mirrors AllowAllGate in src/adapters/conversation-gate rather than
// importing it - core stays free of any dependency on adapters, the same
// reason NOOP_MESSAGE_BUS above is inlined instead of imported.
const ALLOW_ALL_GATE: ConversationGate = {
  async canCreateConversation() {
    return true
  },
}

// Mirrors NoopMessageNotifier in src/adapters/message-notifier rather than
// importing it, the same reasoning as NOOP_MESSAGE_BUS and ALLOW_ALL_GATE
// above.
const NOOP_MESSAGE_NOTIFIER: MessageNotifier = {
  async notify() {},
}

export class MessagingService {
  constructor(
    private readonly conversations: ConversationStore,
    private readonly messages: MessageStore,
    private readonly messageBus: MessageBus = NOOP_MESSAGE_BUS,
    private readonly gate: ConversationGate = ALLOW_ALL_GATE,
    private readonly notifier: MessageNotifier = NOOP_MESSAGE_NOTIFIER,
  ) {}

  async createConversation(requesterId: string, participantIds: string[]): Promise<Conversation> {
    if (!(await this.gate.canCreateConversation(requesterId, participantIds))) {
      throw new ConversationNotAllowedError(requesterId, participantIds)
    }

    return this.conversations.create(participantIds)
  }

  async getConversation(conversationId: string, requesterId: string): Promise<Conversation> {
    return this.requireParticipant(conversationId, requesterId)
  }

  /**
   * Attaches each conversation's most recent message, for the client's
   * "who said what last" list preview - ConversationStore has no
   * dependency on MessageStore (see Conversation.lastMessage's doc
   * comment), so this is the layer that bridges them.
   *
   * One `listByConversation(id, { limit: 1 })` call per conversation. A
   * host with a genuinely large number of conversations per user would
   * want this batched into a single query instead; not worth the added
   * complexity while every real deployment of this service has a handful.
   */
  async listConversations(userId: string): Promise<Conversation[]> {
    const conversations = await this.conversations.findByParticipant(userId)
    const withPreviews = await Promise.all(
      conversations.map(async (conversation) => {
        // `after` is what makes a deleted conversation stay deleted: the
        // preview is drawn only from messages this user has not cleared,
        // so a conversation whose whole history predates their clearedAt
        // has no last message at all and drops out below.
        const clearedAt = participantOf(conversation, userId)?.clearedAt ?? null
        const [lastMessage] = await this.messages.listByConversation(conversation.id, {
          limit: 1,
          ...(clearedAt ? { after: clearedAt } : {}),
        })
        return { conversation, clearedAt, lastMessage: lastMessage ?? null }
      }),
    )

    return withPreviews
      .filter(({ clearedAt, lastMessage }) => clearedAt === null || lastMessage !== null)
      .map(({ conversation, lastMessage }) => ({ ...conversation, lastMessage }))
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    if (input.body.trim().length === 0) {
      throw new EmptyMessageError()
    }

    const conversation = await this.requireParticipant(input.conversationId, input.senderId)

    // Re-checked on every send, not just at creation - a gate whose answer
    // can change after the fact (a revoked share, a removed contact) needs
    // this to actually enforce the change. Without it, a conversation that
    // passed the gate once at creation stays usable forever regardless of
    // what happens to the relationship behind it afterward.
    const participantIds = conversation.participants.map((p) => p.userId)
    if (!(await this.gate.canCreateConversation(input.senderId, participantIds))) {
      throw new ConversationNotAllowedError(input.senderId, participantIds)
    }

    const message = await this.messages.create({
      conversationId: conversation.id,
      senderId: input.senderId,
      body: input.body,
    })

    // Real-time delivery is best-effort on top of a durable write, not part
    // of it - the message already exists once messages.create resolves, so
    // a bus failure here must not surface as a failed send. Same reasoning
    // for the notifier: recipients are everyone else in the conversation,
    // not the sender.
    void this.messageBus.publish(message).catch(() => {})
    const recipientIds = participantIds.filter((id) => id !== input.senderId)
    void this.notifier.notify(message, recipientIds).catch(() => {})

    return message
  }

  async listMessages(
    conversationId: string,
    requesterId: string,
    options?: ListMessagesOptions,
  ): Promise<Message[]> {
    const conversation = await this.requireParticipant(conversationId, requesterId)

    // The requester's own clearedAt wins over anything the caller asked
    // for: `after` is not a client-supplied option on this method, it is
    // how "I deleted this conversation" is enforced on every read of it.
    const clearedAt = participantOf(conversation, requesterId)?.clearedAt ?? null
    return this.messages.listByConversation(conversationId, {
      ...options,
      ...(clearedAt ? { after: clearedAt } : {}),
    })
  }

  /**
   * Deletes one message for everyone in the conversation.
   *
   * Only the sender may do this, which is the whole authorization rule:
   * being able to read a message is not the same as being able to take it
   * back, so a participant deleting someone else's message gets a 403 even
   * though they can see it. The requester comes from the verified token at
   * the HTTP layer, never from the request body.
   *
   * The result is a tombstone rather than a removed row - see
   * Message.deletedAt. Repeating the call on an already-deleted message is
   * a no-op that returns the same tombstone, so a double-tap or a retried
   * request cannot move the deletion's timestamp.
   */
  async deleteMessage(conversationId: string, messageId: string, requesterId: string): Promise<Message> {
    await this.requireParticipant(conversationId, requesterId)

    const message = await this.messages.findById(messageId)
    // A message that belongs to a different conversation is reported as
    // missing, not as forbidden: the requester is a participant of the
    // conversation they named, and telling them a foreign id exists would
    // answer a question they are not entitled to ask.
    if (!message || message.conversationId !== conversationId) {
      throw new MessageNotFoundError(messageId)
    }

    if (message.senderId !== requesterId) {
      throw new NotMessageAuthorError(messageId, requesterId)
    }

    if (message.deletedAt !== null) {
      return message
    }

    const deleted = await this.messages.softDelete(messageId, new Date())

    // Same best-effort delivery as a send, and for the same reason: the
    // deletion is already durable, so a bus failure must not surface as a
    // failed delete. The notifier is deliberately not called - a deletion
    // is not something to push a notification about.
    void this.messageBus.publish(deleted).catch(() => {})

    return deleted
  }

  /**
   * Deletes a conversation for the requester alone. The other participants
   * keep theirs, which is why this sets an instant on the requester's own
   * participant row instead of touching the conversation. See
   * ConversationParticipant.clearedAt.
   *
   * Idempotent in effect but not in timestamp: clearing twice moves the
   * instant forward, which is correct - the second call means "and
   * everything since as well".
   */
  async deleteConversation(conversationId: string, requesterId: string): Promise<void> {
    await this.requireParticipant(conversationId, requesterId)
    await this.conversations.clear(conversationId, requesterId, new Date())
  }

  async markRead(conversationId: string, userId: string, at: Date): Promise<void> {
    await this.requireParticipant(conversationId, userId)
    await this.conversations.markRead(conversationId, userId, at)
  }

  private async requireParticipant(conversationId: string, userId: string): Promise<Conversation> {
    const conversation = await this.conversations.findById(conversationId)
    if (!conversation) {
      throw new ConversationNotFoundError(conversationId)
    }

    if (!isParticipant(conversation, userId)) {
      throw new NotAParticipantError(conversationId, userId)
    }

    return conversation
  }
}
