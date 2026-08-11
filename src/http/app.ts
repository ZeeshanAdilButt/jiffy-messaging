import express, { type Express } from 'express'

import { MessagingService } from '../core/index.js'
import type { ConversationStore, MessageBus, MessageStore, TokenVerifier } from '../ports/index.js'
import { createAuthMiddleware } from './auth-middleware.js'
import { createConversationsRouter } from './conversations-router.js'
import { errorHandler } from './error-handler.js'
import { createHealthRouter } from './health-router.js'
import { createIpRateLimiter, createUserRateLimiter } from './rate-limit.js'

export interface HttpAppConfig {
  conversations: ConversationStore
  messages: MessageStore
  tokenVerifier: TokenVerifier
  /**
   * Passed straight through to MessagingService. Needed whenever this app
   * runs alongside the WebSocket layer, so a message sent over REST still
   * reaches the same bus the WebSocket server is subscribed to. Omit it
   * for an HTTP-only deployment with no real-time delivery.
   */
  messageBus?: MessageBus
  /** See createHealthRouter - backs GET /ready. */
  readinessCheck?: () => Promise<boolean>
}

/**
 * Assembles the REST surface over the core service. This only builds the
 * Express app - binding it to a port is the standalone server's job, so
 * the same app can be tested with supertest or mounted in a bigger
 * process without ever calling listen().
 */
export function createHttpApp(config: HttpAppConfig): Express {
  const messaging = new MessagingService(config.conversations, config.messages, config.messageBus)

  const app = express()
  app.use(express.json())
  // Health and readiness are unauthenticated, unrated, and sit before
  // everything else - a load balancer or kubelet probing them has no
  // bearer token to send and should never be throttled.
  app.use(createHealthRouter({ readinessCheck: config.readinessCheck }))
  // IP-based, ahead of auth: a flood of requests with garbage tokens gets
  // capped before any of them pay the cost of token verification.
  app.use(createIpRateLimiter())
  app.use(createAuthMiddleware(config.tokenVerifier))
  // User-based, after auth resolves who the caller is - see rate-limit.ts.
  app.use(createUserRateLimiter())
  app.use(createConversationsRouter(messaging))
  app.use(errorHandler)

  return app
}
