import type { Message } from '../../domain/index.js'
import type { MessageNotifier } from '../../ports/index.js'

/**
 * The default when no host callback is configured: notifications simply
 * don't happen. A host with no push/email infrastructure of its own sees
 * no behavior change from this feature existing - same reasoning as
 * AllowAllGate for ConversationGate.
 */
export class NoopMessageNotifier implements MessageNotifier {
  async notify(_message: Message, _recipientIds: string[]): Promise<void> {}
}
