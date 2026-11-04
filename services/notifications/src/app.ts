import helmet from '@fastify/helmet'
import {
  NotFoundError,
  Type,
  createHttpApp,
  registerDocs,
  requireAuth,
  requireRole,
  type FastifyPluginAsyncTypebox,
  type Pool,
  type TokenVerifier,
} from '@ticketflow/common'
import type { NotificationsConfig } from './config'
import { verifyTicket } from './tickets'

export interface NotificationsDeps {
  pool: Pool
  verifyToken: TokenVerifier
}

const ErrorRef = { $ref: 'ErrorResponse#' }

export async function buildApp(config: NotificationsConfig, deps: NotificationsDeps) {
  const app = createHttpApp({
    serviceName: 'notifications-worker',
    logLevel: config.LOG_LEVEL,
    readinessChecks: { postgres: () => deps.pool.query('SELECT 1') },
  })
  await app.register(helmet)
  await registerDocs(app, { title: 'TicketFlow · Notifications', version: '0.1.0' })

  const routes: FastifyPluginAsyncTypebox = async (api) => {
    const authenticated = requireAuth(deps.verifyToken)

    api.get(
      '/notifications',
      {
        onRequest: [authenticated, requireRole('admin')],
        schema: {
          tags: ['operación'],
          summary: 'Últimas notificaciones por estado (admin)',
          security: [{ bearerAuth: [] }],
          querystring: Type.Object({
            status: Type.Union([Type.Literal('pending'), Type.Literal('sent'), Type.Literal('failed')], { default: 'failed' }),
          }),
        },
      },
      async (req) => {
        const { rows } = await deps.pool.query(
          `SELECT id, kind, user_id AS "userId", status, attempts, last_error AS "lastError",
                  next_attempt_at AS "nextAttemptAt", sent_at AS "sentAt", created_at AS "createdAt"
             FROM notifications WHERE status = $1 ORDER BY created_at DESC LIMIT 100`,
          [req.query.status],
        )
        return { items: rows }
      },
    )

    api.post(
      '/notifications/:id/retry',
      {
        onRequest: [authenticated, requireRole('admin')],
        schema: {
          tags: ['operación'],
          summary: 'Reencolar una notificación fallida (admin)',
          security: [{ bearerAuth: [] }],
          params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
          response: { 404: ErrorRef },
        },
      },
      async (req) => {
        const { rowCount } = await deps.pool.query(
          `UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
            WHERE id = $1 AND status = 'failed'`,
          [req.params.id],
        )
        if (!rowCount) throw new NotFoundError('NOTIFICATION_NOT_FOUND', 'No hay una notificación fallida con ese id')
        return { requeued: true }
      },
    )

    api.post(
      '/tickets/verify',
      {
        onRequest: [authenticated, requireRole('organizer', 'admin')],
        schema: {
          tags: ['entradas'],
          summary: 'Validar el código QR de una entrada (personal del evento)',
          description: 'Verifica la firma del código. No requiere consultar otros servicios: funciona aunque estén caídos.',
          security: [{ bearerAuth: [] }],
          body: Type.Object({ code: Type.String({ minLength: 1, maxLength: 500 }) }),
        },
      },
      async (req) => {
        const ticket = verifyTicket(config.TICKET_SIGNING_SECRET, req.body.code)
        return ticket ? { valid: true, ticket } : { valid: false }
      },
    )
  }
  await app.register(routes)

  return app
}
