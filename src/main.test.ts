import { describe, expect, it } from 'vitest'

import { JwtTokenVerifier } from './adapters/jwt/index.js'
import { HttpConversationGate } from './adapters/conversation-gate/index.js'
import { HttpMessageNotifier } from './adapters/message-notifier/index.js'
import {
  buildConversationGate,
  buildMessageNotifier,
  buildTokenVerifier,
  missingJwtClaimChecks,
  parseEnv,
} from './main.js'

const BASE_ENV = {
  DATABASE_URL: 'postgres://localhost/test',
  JWT_SECRET: 'a-test-secret',
  CORS_ORIGIN: 'http://localhost:3000',
}

describe('parseEnv', () => {
  it('throws when DATABASE_URL is missing', () => {
    expect(() => parseEnv({ JWT_SECRET: 'x' })).toThrow('DATABASE_URL')
  })

  it('throws when neither JWT_JWKS_URI nor JWT_SECRET is set', () => {
    expect(() => parseEnv({ DATABASE_URL: 'postgres://localhost/test' })).toThrow(
      'Set either JWT_JWKS_URI or JWT_SECRET',
    )
  })

  it('throws when CORS_ORIGIN is missing', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: 'postgres://localhost/test', JWT_SECRET: 'a-test-secret' }),
    ).toThrow('CORS_ORIGIN')
  })

  it('parses a single CORS_ORIGIN', () => {
    expect(parseEnv(BASE_ENV).corsOrigins).toEqual(['http://localhost:3000'])
  })

  it('splits and trims a comma-separated CORS_ORIGIN', () => {
    const config = parseEnv({
      ...BASE_ENV,
      CORS_ORIGIN: ' https://www.goalslot.io , https://goalslot.io ',
    })
    expect(config.corsOrigins).toEqual(['https://www.goalslot.io', 'https://goalslot.io'])
  })

  it('throws when CORS_ORIGIN is set but blank', () => {
    expect(() => parseEnv({ ...BASE_ENV, CORS_ORIGIN: '  ,  ' })).toThrow(
      'CORS_ORIGIN is set but contains no valid origins',
    )
  })

  it('defaults PORT to 8080', () => {
    expect(parseEnv(BASE_ENV).port).toBe(8080)
  })

  it('parses a valid PORT', () => {
    expect(parseEnv({ ...BASE_ENV, PORT: '3000' }).port).toBe(3000)
  })

  it('throws on a non-numeric PORT', () => {
    expect(() => parseEnv({ ...BASE_ENV, PORT: 'not-a-number' })).toThrow('Invalid PORT')
  })

  it('throws on a zero or negative PORT', () => {
    expect(() => parseEnv({ ...BASE_ENV, PORT: '0' })).toThrow('Invalid PORT')
  })

  it('picks the secret kind when only JWT_SECRET is set', () => {
    const config = parseEnv(BASE_ENV)
    expect(config.jwt).toMatchObject({ kind: 'secret', secret: 'a-test-secret' })
  })

  it('picks the jwks kind when JWT_JWKS_URI is set', () => {
    const config = parseEnv({
      ...BASE_ENV,
      JWT_JWKS_URI: 'https://platform.example.com/.well-known/jwks.json',
    })
    expect(config.jwt).toMatchObject({
      kind: 'jwks',
      uri: 'https://platform.example.com/.well-known/jwks.json',
    })
  })

  it('prefers jwks over secret when both are set', () => {
    const config = parseEnv({
      ...BASE_ENV,
      JWT_JWKS_URI: 'https://platform.example.com/.well-known/jwks.json',
    })
    expect(config.jwt.kind).toBe('jwks')
  })

  it('carries issuer, audience, and userIdClaim through when set', () => {
    const config = parseEnv({
      ...BASE_ENV,
      JWT_ISSUER: 'example-platform',
      JWT_AUDIENCE: 'jiffy-messaging',
      JWT_USER_ID_CLAIM: 'platformUserId',
    })
    expect(config.jwt).toMatchObject({
      issuer: 'example-platform',
      audience: 'jiffy-messaging',
      userIdClaim: 'platformUserId',
    })
  })

  it('leaves redisUrl unset when REDIS_URL is not set', () => {
    expect(parseEnv(BASE_ENV).redisUrl).toBeUndefined()
  })

  it('carries redisUrl through when REDIS_URL is set', () => {
    const config = parseEnv({ ...BASE_ENV, REDIS_URL: 'redis://localhost:6379' })
    expect(config.redisUrl).toBe('redis://localhost:6379')
  })

  it('leaves conversationGate unset when neither gate variable is set', () => {
    expect(parseEnv(BASE_ENV).conversationGate).toBeUndefined()
  })

  it('carries conversationGate through when both variables are set', () => {
    const config = parseEnv({
      ...BASE_ENV,
      CONVERSATION_GATE_URL: 'https://api.example.com/internal/messaging/can-create-conversation',
      CONVERSATION_GATE_SECRET: 'shared-secret',
    })
    expect(config.conversationGate).toEqual({
      url: 'https://api.example.com/internal/messaging/can-create-conversation',
      secret: 'shared-secret',
    })
  })

  it('throws when only CONVERSATION_GATE_URL is set', () => {
    expect(() =>
      parseEnv({ ...BASE_ENV, CONVERSATION_GATE_URL: 'https://api.example.com/gate' }),
    ).toThrow('CONVERSATION_GATE_URL and CONVERSATION_GATE_SECRET must both be set, or neither')
  })

  it('throws when only CONVERSATION_GATE_SECRET is set', () => {
    expect(() => parseEnv({ ...BASE_ENV, CONVERSATION_GATE_SECRET: 'shared-secret' })).toThrow(
      'CONVERSATION_GATE_URL and CONVERSATION_GATE_SECRET must both be set, or neither',
    )
  })

  it('leaves messageNotify unset when neither notify variable is set', () => {
    expect(parseEnv(BASE_ENV).messageNotify).toBeUndefined()
  })

  it('carries messageNotify through when both variables are set', () => {
    const config = parseEnv({
      ...BASE_ENV,
      MESSAGE_NOTIFY_URL: 'https://api.example.com/internal/messaging/on-message-sent',
      MESSAGE_NOTIFY_SECRET: 'shared-secret',
    })
    expect(config.messageNotify).toEqual({
      url: 'https://api.example.com/internal/messaging/on-message-sent',
      secret: 'shared-secret',
    })
  })

  it('throws when only MESSAGE_NOTIFY_URL is set', () => {
    expect(() =>
      parseEnv({ ...BASE_ENV, MESSAGE_NOTIFY_URL: 'https://api.example.com/notify' }),
    ).toThrow('MESSAGE_NOTIFY_URL and MESSAGE_NOTIFY_SECRET must both be set, or neither')
  })

  it('throws when only MESSAGE_NOTIFY_SECRET is set', () => {
    expect(() => parseEnv({ ...BASE_ENV, MESSAGE_NOTIFY_SECRET: 'shared-secret' })).toThrow(
      'MESSAGE_NOTIFY_URL and MESSAGE_NOTIFY_SECRET must both be set, or neither',
    )
  })
})

describe('buildConversationGate', () => {
  it("returns undefined when unconfigured, deferring to MessagingService's own default", () => {
    expect(buildConversationGate(undefined)).toBeUndefined()
  })

  it('builds an HttpConversationGate when configured', () => {
    const gate = buildConversationGate({
      url: 'https://api.example.com/internal/messaging/can-create-conversation',
      secret: 'shared-secret',
    })
    expect(gate).toBeInstanceOf(HttpConversationGate)
  })
})

describe('buildMessageNotifier', () => {
  it("returns undefined when unconfigured, deferring to MessagingService's own default", () => {
    expect(buildMessageNotifier(undefined)).toBeUndefined()
  })

  it('builds an HttpMessageNotifier when configured', () => {
    const notifier = buildMessageNotifier({
      url: 'https://api.example.com/internal/messaging/on-message-sent',
      secret: 'shared-secret',
    })
    expect(notifier).toBeInstanceOf(HttpMessageNotifier)
  })
})

describe('missingJwtClaimChecks', () => {
  it('flags both when neither issuer nor audience is set', () => {
    expect(missingJwtClaimChecks({ kind: 'secret', secret: 'x' })).toEqual(['JWT_ISSUER', 'JWT_AUDIENCE'])
  })

  it('flags only audience when issuer is set', () => {
    expect(missingJwtClaimChecks({ kind: 'secret', secret: 'x', issuer: 'example-platform' })).toEqual([
      'JWT_AUDIENCE',
    ])
  })

  it('flags only issuer when audience is set', () => {
    expect(missingJwtClaimChecks({ kind: 'secret', secret: 'x', audience: 'jiffy-messaging' })).toEqual([
      'JWT_ISSUER',
    ])
  })

  it('flags neither when both are set', () => {
    expect(
      missingJwtClaimChecks({ kind: 'secret', secret: 'x', issuer: 'example-platform', audience: 'jiffy-messaging' }),
    ).toEqual([])
  })
})

describe('buildTokenVerifier', () => {
  it('builds a JwtTokenVerifier from a secret config', () => {
    const verifier = buildTokenVerifier({ kind: 'secret', secret: 'a-test-secret' })
    expect(verifier).toBeInstanceOf(JwtTokenVerifier)
  })

  it('builds a JwtTokenVerifier from a jwks config', () => {
    const verifier = buildTokenVerifier({
      kind: 'jwks',
      uri: 'https://platform.example.com/.well-known/jwks.json',
    })
    expect(verifier).toBeInstanceOf(JwtTokenVerifier)
  })
})
