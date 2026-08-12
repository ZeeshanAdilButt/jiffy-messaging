import { jwtVerify, type JWTVerifyGetKey, type KeyInput } from 'jose'

import type { TokenVerifier, VerifiedIdentity } from '../../ports/index.js'

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid token: ${reason}`)
    this.name = 'InvalidTokenError'
  }
}

export interface JwtTokenVerifierOptions {
  issuer?: string
  audience?: string
  /** Claim holding the platform's user id. Defaults to the standard "sub" claim. */
  userIdClaim?: string
}

/**
 * Verifies tokens issued by whatever platform is embedding or calling this
 * service. The key can be a static secret or public key, or a
 * JWTVerifyGetKey such as jose's createRemoteJWKSet - this class does not
 * need to know which, since jose's jwtVerify accepts either. That is what
 * makes this the plug-in boundary: a platform using HMAC-signed tokens and
 * one using RS256 behind a JWKS endpoint both work through the same class.
 */
export class JwtTokenVerifier implements TokenVerifier {
  private readonly userIdClaim: string

  constructor(
    private readonly key: KeyInput | JWTVerifyGetKey,
    private readonly options: JwtTokenVerifierOptions = {},
  ) {
    this.userIdClaim = options.userIdClaim ?? 'sub'
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const payload = await this.verifyPayload(token)

    const userId = payload[this.userIdClaim]
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new InvalidTokenError(`missing or non-string "${this.userIdClaim}" claim`)
    }

    // requiredClaims below already forces exp to be present on anything
    // that reaches this point, but its type in jose's JWTPayload is still
    // `number | undefined`, so this stays a real check rather than an
    // assertion.
    const expiresAt = typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : undefined

    return { userId, expiresAt }
  }

  private async verifyPayload(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        // A token with no "exp" claim is otherwise valid forever once
        // signed - jose only checks expiry when the claim is present, it
        // does not require one. requiredClaims makes the claim mandatory
        // regardless of issuer/audience config, which is what actually
        // closes that hole; issuer and audience stay opt-in (see main.ts)
        // since not every deployment of this service sets them.
        // this.userIdClaim (defaults to "sub") is required for the same
        // reason the manual check above exists: a token that verifies but
        // carries no identity is useless to this service either way.
        requiredClaims: ['exp', this.userIdClaim],
      })
      return payload
    } catch (error) {
      throw new InvalidTokenError(error instanceof Error ? error.message : String(error))
    }
  }
}
