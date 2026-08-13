import { logger } from '../../observability/logger.js'
import type { ConversationGate } from '../../ports/index.js'

export interface HttpConversationGateOptions {
  /** Full URL of the host's authorization endpoint, e.g. https://api.example.com/internal/messaging/can-create-conversation */
  url: string
  /**
   * Sent as `Authorization: Bearer <secret>`. A service-level credential
   * shared only between this process and the host, distinct from any
   * user token - the host's endpoint must reject anything else, since a
   * user token that reached this endpoint would defeat the whole point
   * of asking the host instead of trusting the caller.
   */
  secret: string
  /** Defaults to 5000. */
  timeoutMs?: number
}

interface GateResponseBody {
  allowed?: unknown
}

/**
 * Calls back to a host application over HTTP to decide whether requesterId
 * may be in a conversation with participantIds. This is the adapter a host
 * with its own relationship model configures - GoalSlot's accepted-share
 * rule, for example - so jiffy-messaging never has to know what that model
 * is, only how to ask about it and trust the answer.
 *
 * Fails closed. A network error, a timeout, a non-2xx response, or a body
 * that isn't `{ allowed: true }` are all treated as "not allowed" rather
 * than raising past the caller. An authorization check that silently opens
 * the door when the thing deciding it is unreachable is not an
 * authorization check - and the caller (MessagingService) has no better
 * fallback than "no" for a question it cannot get an answer to.
 */
export class HttpConversationGate implements ConversationGate {
  private readonly timeoutMs: number

  constructor(private readonly options: HttpConversationGateOptions) {
    this.timeoutMs = options.timeoutMs ?? 5000
  }

  async canCreateConversation(requesterId: string, participantIds: string[]): Promise<boolean> {
    let response: Response
    try {
      response = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.secret}`,
        },
        body: JSON.stringify({ requesterId, participantIds }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      logger.error(
        { error, requesterId, url: this.options.url },
        'conversation gate unreachable, failing closed',
      )
      return false
    }

    if (!response.ok) {
      logger.warn(
        { status: response.status, requesterId, url: this.options.url },
        'conversation gate rejected the request, failing closed',
      )
      return false
    }

    let body: GateResponseBody
    try {
      body = (await response.json()) as GateResponseBody
    } catch (error) {
      logger.error(
        { error, requesterId, url: this.options.url },
        'conversation gate returned a body that is not JSON, failing closed',
      )
      return false
    }

    return body.allowed === true
  }
}
