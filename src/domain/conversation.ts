// A conversation is a set of participants who can exchange messages. It has
// no idea why those participants are allowed to talk to each other, that
// decision belongs to whatever created it. See the ConversationGate port
// in src/ports/conversation-gate.ts for where that check actually happens.

import type { Message } from './message.js'

export interface ConversationParticipant {
  userId: string
  /**
   * When this participant last read the conversation, or null if they
   * never have. Tracked per participant rather than per message: a read
   * receipt on every message does not scale past a handful of
   * participants, and nothing here needs more than "have you seen the
   * latest".
   */
  lastReadAt: Date | null
  /**
   * When this participant deleted the conversation for themselves, or null
   * if they never have. Deleting a conversation is per participant on
   * purpose: the other side's copy of a two-party thread is theirs, and
   * nothing one participant does should remove it.
   *
   * The instant is the whole mechanism. A cleared conversation is hidden
   * from that participant's list and its messages up to that instant are
   * hidden from their thread, so anything sent afterwards brings the
   * conversation back with only the new messages in it - which is what
   * makes this survivable without a second "undelete" write on every send.
   *
   * Never leaves the service: the HTTP layer strips it before responding,
   * since "the other person deleted this chat" is not something the other
   * person needs told. See toConversationResponse in the HTTP router.
   */
  clearedAt: Date | null
}

export interface Conversation {
  id: string
  participants: ConversationParticipant[]
  createdAt: Date
  /**
   * The most recent message in this conversation, or null when none has
   * been sent yet. Attached by MessagingService.listConversations (see
   * core/messaging-service.ts) rather than by ConversationStore itself -
   * ConversationStore has no dependency on MessageStore, and the two stay
   * that way. Omitted (not present at all) from a freshly created
   * conversation and from `getConversation`/`findById`, which don't need
   * it; only the list endpoint populates it, for the conversation-list
   * preview.
   */
  lastMessage?: Message | null
}

export function participantOf(
  conversation: Conversation,
  userId: string,
): ConversationParticipant | undefined {
  return conversation.participants.find((p) => p.userId === userId)
}

export function isParticipant(conversation: Conversation, userId: string): boolean {
  return conversation.participants.some((p) => p.userId === userId)
}

export function otherParticipants(
  conversation: Conversation,
  userId: string,
): ConversationParticipant[] {
  return conversation.participants.filter((p) => p.userId !== userId)
}
