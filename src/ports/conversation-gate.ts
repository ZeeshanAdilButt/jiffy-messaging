/**
 * The pluggable authorization hook a host implements when "any two
 * authenticated users may talk to each other" is not the right rule for
 * it. jiffy-messaging has no relationship model of its own - see
 * src/domain/conversation.ts - so it cannot decide whether requesterId is
 * allowed to be in a conversation with participantIds. A host that has
 * its own notion of who may talk to whom (contacts, accepted invitations,
 * team membership, whatever it is) answers that question by implementing
 * this interface and configuring it on MessagingService.
 *
 * Called in two places, not just at creation:
 *
 *   - before a conversation is created, with the full participant list
 *   - before every message send, with the participants of the
 *     conversation being sent to
 *
 * The second call is what makes a relationship change take effect. A host
 * whose rule can flip from true to false after the fact (an unfriended
 * contact, a revoked share, a removed team member) has nothing else to do
 * to enforce that: the very next send re-asks the same question, and a
 * conversation nobody actively archived simply stops accepting new
 * messages once the answer changes to false.
 *
 * Left unconfigured, MessagingService defaults to AllowAllGate (see
 * src/adapters/conversation-gate) - permissive, so a host with no
 * relationship model of its own sees no behavior change at all.
 */
export interface ConversationGate {
  canCreateConversation(requesterId: string, participantIds: string[]): Promise<boolean>
}
