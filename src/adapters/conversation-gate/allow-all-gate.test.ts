import { describe, expect, it } from 'vitest'

import { AllowAllGate } from './allow-all-gate.js'

describe('AllowAllGate', () => {
  it('allows any requester with any participants', async () => {
    const gate = new AllowAllGate()

    await expect(gate.canCreateConversation('user_a', ['user_a', 'user_b'])).resolves.toBe(true)
    await expect(
      gate.canCreateConversation('stranger', ['someone', 'else', 'entirely']),
    ).resolves.toBe(true)
    await expect(gate.canCreateConversation('', [])).resolves.toBe(true)
  })
})
