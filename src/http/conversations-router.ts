import { Router, type NextFunction, type Request, type Response } from 'express'

import type { MessagingService } from '../core/index.js'
import { messagesPublishedTotal } from '../observability/metrics.js'

function userId(res: Response): string {
  return res.locals.userId as string
}

export function createConversationsRouter(messaging: MessagingService): Router {
  const router = Router()

  router.post('/conversations', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const participantIds: unknown = req.body?.participantIds
      if (!Array.isArray(participantIds) || participantIds.some((id) => typeof id !== 'string')) {
        res.status(400).json({ error: 'participantIds must be an array of strings' })
        return
      }
      if (!participantIds.includes(userId(res))) {
        res.status(403).json({ error: 'Cannot create a conversation you are not part of' })
        return
      }

      const conversation = await messaging.createConversation(participantIds)
      res.status(201).json(conversation)
    } catch (error) {
      next(error)
    }
  })

  router.get('/conversations', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const conversations = await messaging.listConversations(userId(res))
      res.status(200).json(conversations)
    } catch (error) {
      next(error)
    }
  })

  router.get('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const conversation = await messaging.getConversation(req.params.id as string, userId(res))
      res.status(200).json(conversation)
    } catch (error) {
      next(error)
    }
  })

  router.post('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: unknown = req.body?.body
      if (typeof body !== 'string') {
        res.status(400).json({ error: 'body must be a string' })
        return
      }

      const message = await messaging.sendMessage({
        conversationId: req.params.id as string,
        senderId: userId(res),
        body,
      })
      messagesPublishedTotal.inc()
      res.status(201).json(message)
    } catch (error) {
      next(error)
    }
  })

  router.get('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawLimit = req.query.limit
      const rawBefore = req.query.before

      const limit = rawLimit !== undefined ? Number(rawLimit) : undefined
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        res.status(400).json({ error: 'limit must be a positive integer' })
        return
      }

      const before = rawBefore !== undefined ? new Date(String(rawBefore)) : undefined
      if (before !== undefined && Number.isNaN(before.getTime())) {
        res.status(400).json({ error: 'before must be a valid date' })
        return
      }

      const messages = await messaging.listMessages(req.params.id as string, userId(res), { limit, before })
      res.status(200).json(messages)
    } catch (error) {
      next(error)
    }
  })

  router.post('/conversations/:id/read', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await messaging.markRead(req.params.id as string, userId(res), new Date())
      res.status(204).send()
    } catch (error) {
      next(error)
    }
  })

  return router
}
