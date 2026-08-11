// A conversation is a set of participants who can exchange messages. It has
// no idea why those participants are allowed to talk to each other, that
// decision belongs to whatever created it. See the ConversationGate port
// in ports.ts for where that check actually happens.

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
}

export function isParticipant(conversation: Conversation, userId: string): boolean {
  return conversation.participants.some((p) => p.userId === userId)
}

export function otherParticipants(conversation: Conversation, userId: string): ConversationParticipant[] {
  return conversation.participants.filter((p) => p.userId !== userId)
}
