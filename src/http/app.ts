import cors from 'cors'
import express, { type Express } from 'express'
import { pinoHttp } from 'pino-http'

import { MessagingService } from '../core/index.js'
import { logger } from '../observability/logger.js'
import type {
  ConversationGate,
  ConversationStore,
  MessageBus,
  MessageNotifier,
  MessageStore,
  TokenVerifier,
} from '../ports/index.js'
import { createAuthMiddleware } from './auth-middleware.js'
import { createConversationsRouter } from './conversations-router.js'
import { errorHandler } from './error-handler.js'
import { createHealthRouter } from './health-router.js'
import { createMetricsRouter } from './metrics-router.js'
import { createIpRateLimiter, createUserRateLimiter } from './rate-limit.js'
import { createRequestMetricsMiddleware } from './request-metrics-middleware.js'

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
  /**
   * Host-level authorization for who may create or continue a
   * conversation with whom. Omit it and MessagingService defaults to
   * allowing any two authenticated callers to talk - see ConversationGate
   * in src/ports for what a host implements to change that.
   */
  conversationGate?: ConversationGate
  /**
   * Fire-and-forget notification hook, called after every message send so
   * a host can push its own notification to the recipients. Omit it and
   * MessagingService defaults to doing nothing - see MessageNotifier in
   * src/ports for what a host implements to change that.
   */
  messageNotifier?: MessageNotifier
  /**
   * Every real caller of this REST surface is a browser making a
   * cross-origin request (this service and the web app it serves are on
   * different origins), and Authorization is not a CORS-safelisted header,
   * so every authenticated call is preceded by a preflight OPTIONS request.
   * With no CORS middleware at all, that preflight either falls through to
   * the auth middleware (which 401s it, since preflight never carries the
   * bearer token) or succeeds with no Access-Control-* headers on the
   * response - either way the browser blocks the real request before it is
   * ever sent, and it looks exactly like a dead network connection from the
   * client's side.
   */
  corsOrigins: string[]
  /** See createHealthRouter - backs GET /ready. */
  readinessCheck?: () => Promise<boolean>
  /**
   * Passed straight to Express's `trust proxy` setting - see
   * https://expressjs.com/en/guide/behind-proxies.html. This has to be
   * correct for the IP-based rate limiter (rate-limit.ts) to see the real
   * client address: without it, every request behind a reverse proxy
   * arrives with the proxy's own address, and the whole limiter collapses
   * into one shared bucket for every client combined. Defaults to 1,
   * correct for exactly one reverse proxy in front of this process - the
   * documented nginx deployment (see docs/vps-deploy.md) and a typical
   * single-hop ingress both satisfy that. Set it to the number of proxy
   * hops between the client and this process if that differs, or to
   * `false` if this process is reachable directly with no proxy at all.
   */
  trustProxy?: number | boolean | string
}

// Kept as a named export so the exact same list is used by the app and by
// the test that verifies it actually redacts (see app.test.ts) - a
// hardcoded duplicate in the test would drift silently if this ever
// changed.
export const LOG_REDACT_PATHS = ['req.headers.authorization', 'req.headers.cookie']

/**
 * Assembles the REST surface over the core service. This only builds the
 * Express app - binding it to a port is the standalone server's job, so
 * the same app can be tested with supertest or mounted in a bigger
 * process without ever calling listen().
 */
export function createHttpApp(config: HttpAppConfig): Express {
  const messaging = new MessagingService(
    config.conversations,
    config.messages,
    config.messageBus,
    config.conversationGate,
    config.messageNotifier,
  )

  const app = express()
  app.set('trust proxy', config.trustProxy ?? 1)
  // First, ahead of everything - including logging. cors() answers the
  // preflight OPTIONS request itself (with the right Access-Control-*
  // headers, no auth required) and stamps Access-Control-Allow-Origin on
  // every other response. Mounted after auth, the preflight would 401
  // before ever reaching here, since a preflight request never carries the
  // bearer token - see corsOrigins above.
  app.use(cors({ origin: config.corsOrigins }))
  // Without redact, pino-http's default request serializer copies every
  // request header - including Authorization - into every completed-request
  // log line at info level. That means every bearer token ever presented to
  // this service ends up in plaintext in logs/stdout.log on the VPS (see
  // docs/vps-deploy.md). redact censors the value in place; it does not
  // change what pino-http logs otherwise.
  app.use(pinoHttp({ logger, redact: LOG_REDACT_PATHS }))
  app.use(createRequestMetricsMiddleware())
  app.use(express.json())
  // Health, readiness, and metrics are unauthenticated, unrated, and sit
  // before everything else - a load balancer, kubelet, or Prometheus
  // scraping them has no bearer token to send and should never be
  // throttled.
  app.use(createHealthRouter({ readinessCheck: config.readinessCheck }))
  app.use(createMetricsRouter())
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
