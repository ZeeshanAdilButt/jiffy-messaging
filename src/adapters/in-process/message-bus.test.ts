import { describe, expect, it } from 'vitest'

import { InProcessMessageBus } from './message-bus.js'

function makeMessage(id: string) {
  return { id, conversationId: 'c1', senderId: 'a', body: 'hi', createdAt: new Date() }
}

describe('InProcessMessageBus', () => {
  it('delivers a published message to a subscribed handler', async () => {
    const bus = new InProcessMessageBus()
    const received: unknown[] = []
    bus.onMessage((message) => received.push(message))

    const message = makeMessage('m1')
    await bus.publish(message)

    expect(received).toEqual([message])
  })

  it('delivers to every subscribed handler', async () => {
    const bus = new InProcessMessageBus()
    const a: unknown[] = []
    const b: unknown[] = []
    bus.onMessage((message) => a.push(message))
    bus.onMessage((message) => b.push(message))

    await bus.publish(makeMessage('m1'))

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('stops delivering after unsubscribing', async () => {
    const bus = new InProcessMessageBus()
    const received: unknown[] = []
    const unsubscribe = bus.onMessage((message) => received.push(message))

    unsubscribe()
    await bus.publish(makeMessage('m1'))

    expect(received).toEqual([])
  })
})
