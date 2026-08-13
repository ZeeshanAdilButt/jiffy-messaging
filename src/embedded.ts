import { MessagingService } from './core/index.js'
import type {
  ConversationGate,
  ConversationStore,
  MessageStore,
  TokenVerifier,
  VerifiedIdentity,
} from './ports/index.js'

export interface EmbeddedMessagingConfig {
  conversations: ConversationStore
  messages: MessageStore
  tokenVerifier: TokenVerifier
  /**
   * Omit for a host with no relationship model of its own - any two
   * authenticated callers may then talk. See ConversationGate in
   * src/ports for what to implement to change that.
   */
  conversationGate?: ConversationGate
}

export interface EmbeddedMessaging {
  verifyToken(token: string): Promise<VerifiedIdentity>
  messaging: MessagingService
}

/**
 * Wires storage and auth ports into one object for embedding directly in a
 * host process: no HTTP, no network hop, just function calls against
 * whatever adapters the host passes in. The standalone server wires those
 * same ports into HTTP and WebSocket instead - this is the other side of
 * that boundary, for hosts that would rather call this in-process than run
 * it as a separate service.
 */
export function createEmbeddedMessaging(config: EmbeddedMessagingConfig): EmbeddedMessaging {
  return {
    verifyToken: (token) => config.tokenVerifier.verify(token),
    messaging: new MessagingService(
      config.conversations,
      config.messages,
      undefined,
      config.conversationGate,
    ),
  }
}
