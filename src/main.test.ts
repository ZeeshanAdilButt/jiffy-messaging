import { describe, expect, it } from 'vitest'

import { JwtTokenVerifier } from './adapters/jwt/index.js'
import { buildTokenVerifier, missingJwtClaimChecks, parseEnv } from './main.js'

const BASE_ENV = { DATABASE_URL: 'postgres://localhost/test', JWT_SECRET: 'a-test-secret' }

describe('parseEnv', () => {
  it('throws when DATABASE_URL is missing', () => {
    expect(() => parseEnv({ JWT_SECRET: 'x' })).toThrow('DATABASE_URL')
  })

  it('throws when neither JWT_JWKS_URI nor JWT_SECRET is set', () => {
    expect(() => parseEnv({ DATABASE_URL: 'postgres://localhost/test' })).toThrow(
      'Set either JWT_JWKS_URI or JWT_SECRET',
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
    const config = parseEnv({ ...BASE_ENV, JWT_JWKS_URI: 'https://platform.example.com/.well-known/jwks.json' })
    expect(config.jwt).toMatchObject({ kind: 'jwks', uri: 'https://platform.example.com/.well-known/jwks.json' })
  })

  it('prefers jwks over secret when both are set', () => {
    const config = parseEnv({ ...BASE_ENV, JWT_JWKS_URI: 'https://platform.example.com/.well-known/jwks.json' })
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
    const verifier = buildTokenVerifier({ kind: 'jwks', uri: 'https://platform.example.com/.well-known/jwks.json' })
    expect(verifier).toBeInstanceOf(JwtTokenVerifier)
  })
})
