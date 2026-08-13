import type { ConversationGate } from '../../ports/index.js'

/**
 * The permissive default: every requester may create or continue any
 * conversation. This is what MessagingService uses when no gate is
 * configured, so a host with no relationship model of its own sees no
 * behavior change from this feature existing.
 *
 * Exported for a host that wants to say so explicitly - passing
 * `new AllowAllGate()` reads the same as omitting the option, but some
 * teams would rather a config file show every decision than rely on a
 * default living in this package's source.
 */
export class AllowAllGate implements ConversationGate {
  async canCreateConversation(_requesterId: string, _participantIds: string[]): Promise<boolean> {
    return true
  }
}
