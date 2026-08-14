import type { Message } from '../domain/index.js'

/**
 * Fire-and-forget notification hook, called after a message has been
 * durably written, so a host can push its own notification (mobile push,
 * web push, email, whatever it has) to the recipients.
 *
 * Unlike ConversationGate, this is not an authorization check.
 * MessagingService never waits on it in any way that could change the
 * outcome of a send, and a failure here must never surface as a failed
 * send - the message already exists by the time this is called. See
 * NoopMessageNotifier in src/adapters/message-notifier for the default
 * when unconfigured.
 */
export interface MessageNotifier {
  notify(message: Message, recipientIds: string[]): Promise<void>
}
