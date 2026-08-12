import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import { InvalidTokenError, JwtTokenVerifier } from './token-verifier.js'

const secret = new TextEncoder().encode('test-signing-secret-at-least-32-bytes-long')

async function signToken(claims: Record<string, unknown>, options: { expiresIn?: string } = {}) {
  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
  if (options.expiresIn) {
    builder = builder.setExpirationTime(options.expiresIn)
  }
  return builder.sign(secret)
}

describe('JwtTokenVerifier', () => {
  it('returns the user id from the sub claim by default', async () => {
    const token = await signToken({ sub: 'user_1' })
    const verifier = new JwtTokenVerifier(secret)

    await expect(verifier.verify(token)).resolves.toEqual({ userId: 'user_1' })
  })

  it('reads the user id from a custom claim when configured', async () => {
    const token = await signToken({ platformUserId: 'user_2' })
    const verifier = new JwtTokenVerifier(secret, { userIdClaim: 'platformUserId' })

    await expect(verifier.verify(token)).resolves.toEqual({ userId: 'user_2' })
  })

  it('rejects a token signed with the wrong secret', async () => {
    const wrongSecret = new TextEncoder().encode('a-completely-different-signing-secret-value')
    const token = await new SignJWT({ sub: 'user_1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .sign(wrongSecret)

    const verifier = new JwtTokenVerifier(secret)
    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError)
  })

  it('rejects an expired token', async () => {
    const token = await signToken({ sub: 'user_1' }, { expiresIn: '-1h' })
    const verifier = new JwtTokenVerifier(secret)

    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError)
  })

  it('rejects a token with the wrong issuer', async () => {
    const token = await new SignJWT({ sub: 'user_1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('untrusted-issuer')
      .sign(secret)

    const verifier = new JwtTokenVerifier(secret, { issuer: 'expected-issuer' })
    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError)
  })

  it('rejects a token with the wrong audience', async () => {
    const token = await new SignJWT({ sub: 'user_1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setAudience('other-app')
      .sign(secret)

    const verifier = new JwtTokenVerifier(secret, { audience: 'expected-app' })
    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError)
  })

  it('rejects a token missing the user id claim', async () => {
    const token = await signToken({ role: 'admin' })
    const verifier = new JwtTokenVerifier(secret)

    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError)
  })

  it('accepts a token that matches the configured issuer and audience', async () => {
    const token = await new SignJWT({ sub: 'user_1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('example-platform')
      .setAudience('jiffy-messaging')
      .sign(secret)

    const verifier = new JwtTokenVerifier(secret, { issuer: 'example-platform', audience: 'jiffy-messaging' })
    await expect(verifier.verify(token)).resolves.toEqual({ userId: 'user_1' })
  })
})

describe('InvalidTokenError', () => {
  it('carries the reason in its message', () => {
    const error = new InvalidTokenError('signature verification failed')
    expect(error.message).toBe('Invalid token: signature verification failed')
    expect(error.name).toBe('InvalidTokenError')
  })
})
