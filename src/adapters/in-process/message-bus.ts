import { EventEmitter } from 'node:events'

import type { Message } from '../../domain/index.js'
import type { MessageBus } from '../../ports/index.js'

const MESSAGE_EVENT = 'message'

/**
 * Single-process implementation of MessageBus: publish() and onMessage()
 * both run in this same process, so this only fans a message out to
 * connections held by this one instance. Use RedisMessageBus instead when
 * running more than one, so a message published on one still reaches a
 * recipient connected to another.
 */
export class InProcessMessageBus implements MessageBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    // A production deployment can have many concurrent conversations, each
    // registering its own handler indirectly through the WebSocket layer's
    // single subscription - but keep this unbounded rather than guessing
    // at a cap and logging spurious "possible memory leak" warnings.
    this.emitter.setMaxListeners(0)
  }

  async publish(message: Message): Promise<void> {
    this.emitter.emit(MESSAGE_EVENT, message)
  }

  onMessage(handler: (message: Message) => void): () => void {
    this.emitter.on(MESSAGE_EVENT, handler)
    return () => this.emitter.off(MESSAGE_EVENT, handler)
  }
}
