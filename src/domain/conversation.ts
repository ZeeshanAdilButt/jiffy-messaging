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

export function isParticipant(conversation: Conversation, userId: string): boolean {
  return conversation.participants.some((p) => p.userId === userId)
}

export function otherParticipants(
  conversation: Conversation,
  userId: string,
): ConversationParticipant[] {
  return conversation.participants.filter((p) => p.userId !== userId)
}
