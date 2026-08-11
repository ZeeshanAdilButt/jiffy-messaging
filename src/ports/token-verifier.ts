export interface VerifiedIdentity {
  userId: string
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
