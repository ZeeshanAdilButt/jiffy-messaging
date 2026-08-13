import type { NextFunction, Request, Response } from 'express'

import {
  ConversationNotAllowedError,
  ConversationNotFoundError,
  EmptyMessageError,
  NotAParticipantError,
} from '../core/index.js'

// Express only treats a 4-argument function as an error handler, so _req
// and _next stay in the signature even though this one doesn't use them.
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ConversationNotFoundError) {
    res.status(404).json({ error: error.message })
    return
  }

  if (error instanceof NotAParticipantError) {
    res.status(403).json({ error: error.message })
    return
  }

  if (error instanceof ConversationNotAllowedError) {
    res.status(403).json({ error: error.message })
    return
  }

  if (error instanceof EmptyMessageError) {
    res.status(400).json({ error: error.message })
    return
  }

  res.status(500).json({ error: 'Internal server error' })
}
