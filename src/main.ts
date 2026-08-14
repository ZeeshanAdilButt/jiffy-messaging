import { createRemoteJWKSet } from 'jose'
import { Redis } from 'ioredis'
import { Pool } from 'pg'
import { pathToFileURL } from 'node:url'

import { JwtTokenVerifier } from './adapters/jwt/index.js'
import { HttpConversationGate } from './adapters/conversation-gate/index.js'
import { HttpMessageNotifier } from './adapters/message-notifier/index.js'
import { RedisMessageBus } from './adapters/redis/index.js'
import { logger } from './observability/logger.js'
import type { ConversationGate, MessageNotifier } from './ports/index.js'
import { createServer } from './server/create-server.js'

export type JwtEnvConfig =
  | { kind: 'secret'; secret: string; issuer?: string; audience?: string; userIdClaim?: string }
  | { kind: 'jwks'; uri: string; issuer?: string; audience?: string; userIdClaim?: string }

export interface ConversationGateEnvConfig {
  url: string
  secret: string
}

export interface MessageNotifyEnvConfig {
  url: string
  secret: string
}

export interface ParsedEnv {
  databaseUrl: string
  port: number
  jwt: JwtEnvConfig
  /** Unset means run as a single instance, using the in-process bus. */
  redisUrl?: string
  /** Unset means any two authenticated callers may talk - see readMessagingGate below. */
  conversationGate?: ConversationGateEnvConfig
  /** Unset means no notification fires when a message is sent - see readMessageNotifyEnv below. */
  messageNotify?: MessageNotifyEnvConfig
  /** Origins allowed to call the REST API from a browser - see readCorsOriginEnv below. */
  corsOrigins: string[]
}

/**
 * Reads and validates the environment this process needs to run, without
 * touching a database or a network - kept pure and separate from run() so
 * a bad config fails fast with a clear message, and so it is testable
 * without standing up real infrastructure.
 */
export function parseEnv(env: NodeJS.ProcessEnv): ParsedEnv {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('Missing required environment variable: DATABASE_URL')
  }

  const port = env.PORT !== undefined ? Number(env.PORT) : 8080
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${env.PORT}`)
  }

  const issuer = env.JWT_ISSUER
  const audience = env.JWT_AUDIENCE
  const userIdClaim = env.JWT_USER_ID_CLAIM
  const redisUrl = env.REDIS_URL
  const conversationGate = readConversationGateEnv(env)
  const messageNotify = readMessageNotifyEnv(env)

  // JWT_JWKS_URI wins if both are set, since a platform that has moved to
  // rotating keys behind a JWKS endpoint has no reason to also keep a
  // static secret configured.
  let jwt: JwtEnvConfig
  if (env.JWT_JWKS_URI) {
    jwt = { kind: 'jwks', uri: env.JWT_JWKS_URI, issuer, audience, userIdClaim }
  } else if (env.JWT_SECRET) {
    jwt = { kind: 'secret', secret: env.JWT_SECRET, issuer, audience, userIdClaim }
  } else {
    throw new Error('Set either JWT_JWKS_URI or JWT_SECRET')
  }

  const corsOrigins = readCorsOriginEnv(env)

  return { databaseUrl, port, redisUrl, conversationGate, messageNotify, corsOrigins, jwt }
}

/**
 * Required, not optional: every real caller of the REST API (/conversations,
 * /conversations/:id/messages, etc) is a browser, and a browser calling
 * cross-origin with no CORS configuration at all gets every request silently
 * blocked before it leaves the tab - no CORS headers ever appear on any
 * response here, so the whole REST surface is unreachable and the failure
 * looks like a dead network connection, not a 401 or a 500. Comma-separated
 * to match dw-time-api's CORS_ORIGIN convention.
 */
function readCorsOriginEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CORS_ORIGIN
  if (!raw) {
    throw new Error(
      'Missing required environment variable: CORS_ORIGIN (comma-separated list of allowed browser origins, e.g. https://www.goalslot.io)',
    )
  }
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (origins.length === 0) {
    throw new Error('CORS_ORIGIN is set but contains no valid origins')
  }
  return origins
}

/**
 * CONVERSATION_GATE_URL and CONVERSATION_GATE_SECRET must be set together
 * or not at all - a URL with no secret would call a host endpoint with no
 * credential, and a secret with no URL has nothing to send it to. Either
 * half-configured case is almost certainly a typo, so this fails fast
 * rather than silently running unconfigured (any two callers may talk) or
 * silently running with an empty credential (every call rejected).
 */
function readConversationGateEnv(env: NodeJS.ProcessEnv): ConversationGateEnvConfig | undefined {
  const url = env.CONVERSATION_GATE_URL
  const secret = env.CONVERSATION_GATE_SECRET

  if (!url && !secret) return undefined

  if (!url || !secret) {
    throw new Error(
      'CONVERSATION_GATE_URL and CONVERSATION_GATE_SECRET must both be set, or neither',
    )
  }

  return { url, secret }
}

/**
 * MESSAGE_NOTIFY_URL and MESSAGE_NOTIFY_SECRET must be set together or not
 * at all - same reasoning as readConversationGateEnv above, and a
 * deliberately separate secret from CONVERSATION_GATE_SECRET: this
 * endpoint and the gate endpoint are different capabilities on the host,
 * and a caller with one should not automatically have the other.
 */
function readMessageNotifyEnv(env: NodeJS.ProcessEnv): MessageNotifyEnvConfig | undefined {
  const url = env.MESSAGE_NOTIFY_URL
  const secret = env.MESSAGE_NOTIFY_SECRET

  if (!url && !secret) return undefined

  if (!url || !secret) {
    throw new Error('MESSAGE_NOTIFY_URL and MESSAGE_NOTIFY_SECRET must both be set, or neither')
  }

  return { url, secret }
}

/**
 * Builds the real JWT adapter from parsed config. Whether the platform in
 * front of this service signs with a static secret or rotates keys behind
 * a JWKS endpoint is exactly the choice JwtTokenVerifier's constructor was
 * built to accept without caring which - this function just makes that
 * choice from environment variables instead of code.
 */
export function buildTokenVerifier(jwt: JwtEnvConfig): JwtTokenVerifier {
  const options = { issuer: jwt.issuer, audience: jwt.audience, userIdClaim: jwt.userIdClaim }

  if (jwt.kind === 'jwks') {
    return new JwtTokenVerifier(createRemoteJWKSet(new URL(jwt.uri)), options)
  }

  return new JwtTokenVerifier(new TextEncoder().encode(jwt.secret), options)
}

/**
 * JWT_ISSUER and JWT_AUDIENCE stay optional rather than required - making
 * them mandatory would break any already-deployed caller that has not set
 * them, and the one fix that actually matters (a token must carry an
 * "exp" claim) does not depend on either being set; see
 * JwtTokenVerifier.verifyPayload. But an unset issuer or audience means
 * this service accepts a correctly-signed token issued for a completely
 * different platform or a completely different consumer of the same
 * platform, so it is worth a loud warning rather than a silent default.
 */
export function missingJwtClaimChecks(jwt: JwtEnvConfig): string[] {
  const missing: string[] = []
  if (!jwt.issuer) missing.push('JWT_ISSUER')
  if (!jwt.audience) missing.push('JWT_AUDIENCE')
  return missing
}

/**
 * Builds the real HTTP adapter from parsed config, or undefined when
 * CONVERSATION_GATE_URL/SECRET are unset - MessagingService's own default
 * (allow any two callers to talk) takes over in that case, so this stays
 * undefined rather than reaching for a permissive gate of its own.
 */
export function buildConversationGate(
  config: ConversationGateEnvConfig | undefined,
): ConversationGate | undefined {
  if (!config) return undefined
  return new HttpConversationGate({ url: config.url, secret: config.secret })
}

/**
 * Builds the real HTTP adapter from parsed config, or undefined when
 * MESSAGE_NOTIFY_URL/SECRET are unset - MessagingService's own default
 * (send no notification) takes over in that case, so this stays undefined
 * rather than reaching for a no-op notifier of its own.
 */
export function buildMessageNotifier(
  config: MessageNotifyEnvConfig | undefined,
): MessageNotifier | undefined {
  if (!config) return undefined
  return new HttpMessageNotifier({ url: config.url, secret: config.secret })
}

export function run(): void {
  const config = parseEnv(process.env)
  const pool = new Pool({ connectionString: config.databaseUrl })
  const tokenVerifier = buildTokenVerifier(config.jwt)
  const conversationGate = buildConversationGate(config.conversationGate)
  const messageNotifier = buildMessageNotifier(config.messageNotify)

  const missingJwtClaims = missingJwtClaimChecks(config.jwt)
  if (missingJwtClaims.length > 0) {
    logger.warn(
      { missing: missingJwtClaims },
      `${missingJwtClaims.join(' and ')} not set - this service will accept a correctly-signed token from any issuer or audience. Set both in production.`,
    )
  }

  // Two connections because a connection subscribed to a channel can't
  // also issue publish or other commands - see RedisMessageBus.
  const redisClients = config.redisUrl
    ? [new Redis(config.redisUrl), new Redis(config.redisUrl)]
    : []
  const messageBus =
    redisClients.length > 0 ? new RedisMessageBus(redisClients[0]!, redisClients[1]!) : undefined

  const server = createServer({
    pool,
    tokenVerifier,
    messageBus,
    conversationGate,
    messageNotifier,
    corsOrigins: config.corsOrigins,
  })

  server.listen(config.port, () => {
    const mode = messageBus ? 'multi-instance, via Redis' : 'single instance, in-process'
    const gate = conversationGate ? 'host-authorized' : 'unrestricted'
    const notify = messageNotifier ? 'enabled' : 'disabled'
    logger.info(
      { port: config.port, mode, conversationGate: gate, messageNotify: notify },
      'jiffy-messaging listening',
    )
  })

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down')
    server.close(() => {
      void Promise.all([pool.end(), ...redisClients.map((client) => client.quit())]).finally(() =>
        process.exit(0),
      )
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// Only run when this file is the process entry point, not when it is
// imported - that is what lets the tests exercise parseEnv and
// buildTokenVerifier without starting a real server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
