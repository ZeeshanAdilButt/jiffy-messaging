import type { Message } from '../domain/index.js'

/**
 * Pub/sub for real-time delivery. The core publishes a message after
 * storing it; whatever is attached to onMessage (a WebSocket server, for
 * instance) decides what to do with it. A single-process implementation
 * and a Redis-backed one for multiple instances both satisfy this same
 * shape, so swapping one for the other never touches the core.
 */
export interface MessageBus {
  publish(message: Message): Promise<void>
  onMessage(handler: (message: Message) => void): () => void
}
