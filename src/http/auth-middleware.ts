import type { NextFunction, Request, Response } from 'express'

import type { TokenVerifier } from '../ports/index.js'

/**
 * Every route past this middleware can assume res.locals.userId is set -
 * a request that fails verification never reaches the router at all.
 */
export function createAuthMiddleware(tokenVerifier: TokenVerifier) {
  return async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.header('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined

    if (!token) {
      res.status(401).json({ error: 'Missing bearer token' })
      return
    }

    try {
      const identity = await tokenVerifier.verify(token)
      res.locals.userId = identity.userId
      next()
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' })
    }
  }
}
