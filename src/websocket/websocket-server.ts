import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { WebSocketServer } from 'ws'

import type { Message } from '../domain/index.js'
import type { ConversationStore, MessageBus, TokenVerifier } from '../ports/index.js'
import { ConnectionRegistry } from './connection-registry.js'

export interface AttachWebSocketServerConfig {
  server: HttpServer
  tokenVerifier: TokenVerifier
  conversations: ConversationStore
  messageBus: MessageBus
}

function extractToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '', 'http://localhost')
  return url.searchParams.get('token')
}

async function deliverToParticipants(
  message: Message,
  conversations: ConversationStore,
  registry: ConnectionRegistry,
): Promise<void> {
  const conversation = await conversations.findById(message.conversationId)
  if (!conversation) return

  const payload = JSON.stringify(message)
  for (const participant of conversation.participants) {
    for (const socket of registry.get(participant.userId)) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload)
      }
    }
  }
}

/**
 * Attaches a WebSocket endpoint to an existing HTTP server for real-time
 * message delivery, authenticated through the same TokenVerifier port the
 * REST layer uses. The token travels as a query parameter on the
 * connection URL rather than a header, since browsers cannot set custom
 * headers on a WebSocket handshake.
 *
 * Verification happens during the upgrade, before the handshake completes
 * - handleUpgrade is only called once a token has verified, so an
 * unauthenticated caller never gets a live socket, not even briefly.
 *
 * This assumes it owns every upgrade event on the given server, which
 * holds for the standalone server this package builds in a later phase.
 */
export function attachWebSocketServer(config: AttachWebSocketServerConfig): ConnectionRegistry {
  const registry = new ConnectionRegistry()
  const wss = new WebSocketServer({ noServer: true })

  config.server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const token = extractToken(req)
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      let userId: string
      try {
        userId = (await config.tokenVerifier.verify(token)).userId
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        registry.add(userId, ws)
        ws.on('close', () => registry.remove(userId, ws))
      })
    })()
  })

  config.messageBus.onMessage((message) => {
    void deliverToParticipants(message, config.conversations, registry)
  })

  return registry
}
