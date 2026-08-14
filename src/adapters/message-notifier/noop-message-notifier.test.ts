import { describe, expect, it } from 'vitest'

import { NoopMessageNotifier } from './noop-message-notifier.js'

describe('NoopMessageNotifier', () => {
  it('resolves without doing anything, for any message and recipients', async () => {
    const notifier = new NoopMessageNotifier()

    await expect(
      notifier.notify(
        { id: 'msg_1', conversationId: 'conv_1', senderId: 'user_a', body: 'hi', createdAt: new Date() },
        ['user_b', 'user_c'],
      ),
    ).resolves.toBeUndefined()
  })
})
