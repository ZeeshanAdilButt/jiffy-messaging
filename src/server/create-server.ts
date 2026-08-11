import { createServer as createHttpServer, type Server } from 'node:http'
import type { Pool } from 'pg'

import { InProcessMessageBus } from '../adapters/in-process/index.js'
import { PostgresConversationStore, PostgresMessageStore } from '../adapters/postgres/index.js'
import { createHttpApp } from '../http/index.js'
import type { MessageBus, TokenVerifier } from '../ports/index.js'
import { attachWebSocketServer } from '../websocket/index.js'

export interface CreateServerConfig {
  pool: Pool
  tokenVerifier: TokenVerifier
  /**
   * Defaults to InProcessMessageBus, correct for a single running
   * instance. Pass a RedisMessageBus here to run more than one instance
   * behind a load balancer and still have messages reach a recipient
   * connected to a different one.
   */
  messageBus?: MessageBus
}

/**
 * Wires the Postgres adapter, the HTTP layer, and the WebSocket layer into
 * one runnable process. Takes an already-constructed Pool and
 * TokenVerifier rather than building them itself, so this stays testable
 * against a fake pool or a fake verifier - main.ts is the thin layer above
 * this that reads environment variables and builds the real JWT adapter.
 *
 * Returns an http.Server without calling listen(), the same reasoning as
 * createHttpApp not calling it: binding to a port is a separate, later
 * step, kept out of the part that is actually worth testing.
 */
export function createServer(config: CreateServerConfig): Server {
  const conversations = new PostgresConversationStore(config.pool)
  const messages = new PostgresMessageStore(config.pool)
  const messageBus = config.messageBus ?? new InProcessMessageBus()

  const app = createHttpApp({
    conversations,
    messages,
    tokenVerifier: config.tokenVerifier,
    messageBus,
  })

  const server = createHttpServer(app)

  attachWebSocketServer({
    server,
    tokenVerifier: config.tokenVerifier,
    conversations,
    messageBus,
  })

  return server
}
