export interface VerifiedIdentity {
  userId: string
  /**
   * When the underlying token expires, if the verifier knows. Optional
   * because not every TokenVerifier implementation is backed by a token
   * that has an expiry a caller can read back out - a hand-rolled
   * implementation is free to leave this unset. Consumers that care about
   * a long-lived connection outliving the token that opened it (see the
   * WebSocket server) use this to react before the token would otherwise
   * still be trusted.
   */
  expiresAt?: Date
}

/**
 * Verifies a token issued by whatever platform is embedding or calling
 * this service. This is the boundary a consuming platform implements to
 * plug its own auth in, so the core never needs to know how a user was
 * authenticated.
 */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>
}
