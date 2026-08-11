import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'

import type { Message } from '../../domain/index.js'
import type { MessageBus } from '../../ports/index.js'

const CHANNEL = 'jiffy-messaging:messages'
const LOCAL_EVENT = 'message'

function parseMessage(payload: string): Message {
  return JSON.parse(payload, (key, value) => (key === 'createdAt' ? new Date(value) : value)) as Message
}

/**
 * Multi-instance implementation of MessageBus: publish() sends to a Redis
 * channel, and every instance's subscriber connection receives it, not
 * just the instance that handled the original request. That is what lets
 * a message sent while a recipient is connected to one running instance
 * still reach them on another.
 *
 * Redis requires a connection in subscribe mode to be dedicated to that -
 * it can't also issue publish or other commands - so this takes two
 * separate ioredis clients rather than one.
 */
export class RedisMessageBus implements MessageBus {
  private readonly emitter = new EventEmitter()
  private subscribed = false

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {
    this.emitter.setMaxListeners(0)
    this.subscriber.on('message', (channel: string, payload: string) => {
      if (channel !== CHANNEL) return
      this.emitter.emit(LOCAL_EVENT, parseMessage(payload))
    })
  }

  async publish(message: Message): Promise<void> {
    await this.publisher.publish(CHANNEL, JSON.stringify(message))
  }

  onMessage(handler: (message: Message) => void): () => void {
    if (!this.subscribed) {
      this.subscribed = true
      void this.subscriber.subscribe(CHANNEL)
    }

    this.emitter.on(LOCAL_EVENT, handler)
    return () => this.emitter.off(LOCAL_EVENT, handler)
  }
}
