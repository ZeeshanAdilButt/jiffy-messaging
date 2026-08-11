import { createRemoteJWKSet } from 'jose'
import { Redis } from 'ioredis'
import { Pool } from 'pg'
import { pathToFileURL } from 'node:url'

import { JwtTokenVerifier } from './adapters/jwt/index.js'
import { RedisMessageBus } from './adapters/redis/index.js'
import { createServer } from './server/create-server.js'

export type JwtEnvConfig =
  | { kind: 'secret'; secret: string; issuer?: string; audience?: string; userIdClaim?: string }
  | { kind: 'jwks'; uri: string; issuer?: string; audience?: string; userIdClaim?: string }

export interface ParsedEnv {
  databaseUrl: string
  port: number
  jwt: JwtEnvConfig
  /** Unset means run as a single instance, using the in-process bus. */
  redisUrl?: string
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

  // JWT_JWKS_URI wins if both are set, since a platform that has moved to
  // rotating keys behind a JWKS endpoint has no reason to also keep a
  // static secret configured.
  if (env.JWT_JWKS_URI) {
    return {
      databaseUrl,
      port,
      redisUrl,
      jwt: { kind: 'jwks', uri: env.JWT_JWKS_URI, issuer, audience, userIdClaim },
    }
  }

  if (env.JWT_SECRET) {
    return {
      databaseUrl,
      port,
      redisUrl,
      jwt: { kind: 'secret', secret: env.JWT_SECRET, issuer, audience, userIdClaim },
    }
  }

  throw new Error('Set either JWT_JWKS_URI or JWT_SECRET')
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

export function run(): void {
  const config = parseEnv(process.env)
  const pool = new Pool({ connectionString: config.databaseUrl })
  const tokenVerifier = buildTokenVerifier(config.jwt)

  // Two connections because a connection subscribed to a channel can't
  // also issue publish or other commands - see RedisMessageBus.
  const redisClients = config.redisUrl ? [new Redis(config.redisUrl), new Redis(config.redisUrl)] : []
  const messageBus = redisClients.length > 0 ? new RedisMessageBus(redisClients[0]!, redisClients[1]!) : undefined

  const server = createServer({ pool, tokenVerifier, messageBus })

  server.listen(config.port, () => {
    const mode = messageBus ? 'multi-instance, via Redis' : 'single instance, in-process'
    console.log(`jiffy-messaging listening on port ${config.port} (${mode})`)
  })

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down`)
    server.close(() => {
      void Promise.all([pool.end(), ...redisClients.map((client) => client.quit())]).finally(() => process.exit(0))
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
