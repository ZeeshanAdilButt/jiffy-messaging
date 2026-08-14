import { logger } from '../../observability/logger.js'
import type { Message } from '../../domain/index.js'
import type { MessageNotifier } from '../../ports/index.js'

export interface HttpMessageNotifierOptions {
  /** Full URL of the host's notification endpoint, e.g. https://api.example.com/internal/messaging/on-message-sent */
  url: string
  /**
   * Sent as `Authorization: Bearer <secret>`. A service-level credential
   * shared only between this process and the host - same pattern as
   * HttpConversationGate's secret, and deliberately a different value from
   * it: this endpoint and the gate endpoint are different capabilities,
   * and a caller with one should not automatically have the other.
   */
  secret: string
  /** Defaults to 5000. */
  timeoutMs?: number
}

/**
 * Calls back to a host application over HTTP after a message is sent, so
 * it can dispatch its own notifications (push, email, whatever it has).
 *
 * Unlike HttpConversationGate, this does NOT fail closed - there is
 * nothing to fail closed on. The message this fires for is already
 * durably written; a network error, a timeout, or a non-2xx response from
 * the host is logged and swallowed, never raised past the caller. An
 * unreachable notification endpoint should cost the recipient a
 * notification, not cost the sender their message.
 */
export class HttpMessageNotifier implements MessageNotifier {
  private readonly timeoutMs: number

  constructor(private readonly options: HttpMessageNotifierOptions) {
    this.timeoutMs = options.timeoutMs ?? 5000
  }

  async notify(message: Message, recipientIds: string[]): Promise<void> {
    if (recipientIds.length === 0) return

    try {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.secret}`,
        },
        body: JSON.stringify({
          messageId: message.id,
          conversationId: message.conversationId,
          senderId: message.senderId,
          recipientIds,
          body: message.body,
          createdAt: message.createdAt,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (!response.ok) {
        logger.warn(
          { status: response.status, messageId: message.id, url: this.options.url },
          'message notify webhook rejected the request',
        )
      }
    } catch (error) {
      logger.error({ error, messageId: message.id, url: this.options.url }, 'message notify webhook unreachable')
    }
  }
}
