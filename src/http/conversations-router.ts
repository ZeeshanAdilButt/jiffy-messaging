import { Router, type NextFunction, type Request, type Response } from 'express'

import type { Conversation } from '../domain/index.js'
import type { MessagingService } from '../core/index.js'
import { messagesPublishedTotal } from '../observability/metrics.js'

function userId(res: Response): string {
  return res.locals.userId as string
}

/**
 * With no cap, a single request could hand PostgresConversationStore.create
 * an arbitrarily large participantIds array, one INSERT with an
 * arbitrarily large parameter and an arbitrarily large conversation row
 * set to build a response from - all inside one open transaction. This is
 * the DTO-layer boundary where an untrusted client's request becomes a
 * validated call into the core, so it is where that gets stopped, rather
 * than relying on every current and future ConversationStore
 * implementation to enforce it itself.
 */
const MAX_PARTICIPANTS = 50

/**
 * Strips `clearedAt` from every participant before a conversation goes out
 * over the wire. It is server-side state about whether someone deleted
 * their own copy of the thread, and no client has any use for it - least
 * of all the other participant, to whom it would read as "they deleted
 * this chat on <date>". Nothing else about a participant is hidden, so
 * this is a projection rather than a general-purpose serializer.
 */
function toConversationResponse(conversation: Conversation) {
  return {
    ...conversation,
    participants: conversation.participants.map(({ userId, lastReadAt }) => ({ userId, lastReadAt })),
  }
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
      if (participantIds.length > MAX_PARTICIPANTS) {
        res.status(400).json({ error: `participantIds cannot exceed ${MAX_PARTICIPANTS} entries` })
        return
      }
      if (!participantIds.includes(userId(res))) {
        res.status(403).json({ error: 'Cannot create a conversation you are not part of' })
        return
      }

      const conversation = await messaging.createConversation(userId(res), participantIds)
      res.status(201).json(toConversationResponse(conversation))
    } catch (error) {
      next(error)
    }
  })

  router.get('/conversations', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const conversations = await messaging.listConversations(userId(res))
      res.status(200).json(conversations.map(toConversationResponse))
    } catch (error) {
      next(error)
    }
  })

  router.get('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const conversation = await messaging.getConversation(req.params.id as string, userId(res))
      res.status(200).json(toConversationResponse(conversation))
    } catch (error) {
      next(error)
    }
  })

  router.post(
    '/conversations/:id/messages',
    async (req: Request, res: Response, next: NextFunction) => {
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
    },
  )

  router.get(
    '/conversations/:id/messages',
    async (req: Request, res: Response, next: NextFunction) => {
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

        const messages = await messaging.listMessages(req.params.id as string, userId(res), {
          limit,
          before,
        })
        res.status(200).json(messages)
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/conversations/:id/read',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await messaging.markRead(req.params.id as string, userId(res), new Date())
        res.status(204).send()
      } catch (error) {
        next(error)
      }
    },
  )

  // Deletes for everyone, and only the sender may ask. Who is asking comes
  // from res.locals.userId, set by the auth middleware from the verified
  // token - there is no user id anywhere in this request for a client to
  // supply. The tombstone comes back in the response so the caller can
  // redraw the message in place rather than refetch the thread.
  router.delete(
    '/conversations/:id/messages/:messageId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const message = await messaging.deleteMessage(
          req.params.id as string,
          req.params.messageId as string,
          userId(res),
        )
        res.status(200).json(message)
      } catch (error) {
        next(error)
      }
    },
  )

  // Deletes for the caller only. Every other participant keeps the
  // conversation and its history exactly as it was.
  router.delete('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await messaging.deleteConversation(req.params.id as string, userId(res))
      res.status(204).send()
    } catch (error) {
      next(error)
    }
  })

  return router
}
