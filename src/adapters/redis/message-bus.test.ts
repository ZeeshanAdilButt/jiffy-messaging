import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Redis } from 'ioredis'

import { RedisMessageBus } from './message-bus.js'

// ioredis's Redis client is itself an EventEmitter with publish/subscribe
// commands; a fake with just those pieces is enough to test this adapter's
// own logic without a live Redis server. Real cross-process delivery is
// Redis's job, not this class's.
class FakeRedisClient extends EventEmitter {
  publishCalls: Array<[string, string]> = []
  subscribeCalls: string[] = []

  async publish(channel: string, payload: string): Promise<number> {
    this.publishCalls.push([channel, payload])
    return 1
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribeCalls.push(channel)
    return 1
  }
}

function makeMessage(id: string) {
  return {
    id,
    conversationId: 'c1',
    senderId: 'a',
    body: 'hi',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

describe('RedisMessageBus', () => {
  it('publishes to the shared channel as JSON', async () => {
    const publisher = new FakeRedisClient()
    const subscriber = new FakeRedisClient()
    const bus = new RedisMessageBus(publisher as unknown as Redis, subscriber as unknown as Redis)

    const message = makeMessage('m1')
    await bus.publish(message)

    expect(publisher.publishCalls).toHaveLength(1)
    const [channel, payload] = publisher.publishCalls[0]!
    expect(channel).toBe('jiffy-messaging:messages')
    expect(JSON.parse(payload)).toMatchObject({ id: 'm1', body: 'hi' })
  })

  it('subscribes to the channel on the first onMessage call', () => {
    const publisher = new FakeRedisClient()
    const subscriber = new FakeRedisClient()
    const bus = new RedisMessageBus(publisher as unknown as Redis, subscriber as unknown as Redis)

    bus.onMessage(() => {})
    bus.onMessage(() => {})

    expect(subscriber.subscribeCalls).toEqual(['jiffy-messaging:messages'])
  })

  it('delivers a message received on the subscriber connection, reviving createdAt', () => {
    const publisher = new FakeRedisClient()
    const subscriber = new FakeRedisClient()
    const bus = new RedisMessageBus(publisher as unknown as Redis, subscriber as unknown as Redis)

    const received: unknown[] = []
    bus.onMessage((message) => received.push(message))

    const message = makeMessage('m1')
    subscriber.emit('message', 'jiffy-messaging:messages', JSON.stringify(message))

    expect(received).toEqual([message])
    expect((received[0] as { createdAt: Date }).createdAt).toBeInstanceOf(Date)
  })

  it('ignores messages on unrelated channels', () => {
    const publisher = new FakeRedisClient()
    const subscriber = new FakeRedisClient()
    const bus = new RedisMessageBus(publisher as unknown as Redis, subscriber as unknown as Redis)

    const received: unknown[] = []
    bus.onMessage((message) => received.push(message))

    subscriber.emit('message', 'some-other-channel', JSON.stringify(makeMessage('m1')))

    expect(received).toEqual([])
  })

  it('delivers to multiple handlers and lets each unsubscribe independently', () => {
    const publisher = new FakeRedisClient()
    const subscriber = new FakeRedisClient()
    const bus = new RedisMessageBus(publisher as unknown as Redis, subscriber as unknown as Redis)

    const a: unknown[] = []
    const b: unknown[] = []
    bus.onMessage((message) => a.push(message))
    const unsubscribeB = bus.onMessage((message) => b.push(message))

    subscriber.emit('message', 'jiffy-messaging:messages', JSON.stringify(makeMessage('m1')))
    unsubscribeB()
    subscriber.emit('message', 'jiffy-messaging:messages', JSON.stringify(makeMessage('m2')))

    expect(a).toHaveLength(2)
    expect(b).toHaveLength(1)
  })
})
