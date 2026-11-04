import type { Pool } from '@ticketflow/common'
import type { NotificationKind } from './handlers'
import type { Mailer } from './mailer'
import { MissingDataError, renderEmail, type EventInfo } from './templates'

export interface DispatchOptions {
  maxAttempts: number
  retryBaseSeconds: number
  timezone: string
  ticketSecret: string
  batchSize?: number
  /** Cuánto tiempo queda "tomada" una notificación mientras se envía. */
  leaseSeconds?: number
}

interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

interface ClaimedNotification {
  id: string
  kind: NotificationKind
  userId: string
  eventId: string | null
  payload: Record<string, unknown>
  attempts: number
}

/** Backoff exponencial con jitter (±20%) y tope de 1 hora. */
export function backoffSeconds(attempt: number, baseSeconds: number) {
  const exponential = Math.min(baseSeconds * 2 ** (attempt - 1), 3600)
  return Math.round(exponential * (0.8 + Math.random() * 0.4))
}

/**
 * Envía las notificaciones pendientes cuyo momento llegó.
 *
 * Patrón "lease" (como el visibility timeout de SQS): primero se reclaman las
 * filas corriendo su next_attempt_at hacia adelante (commit) y recién después
 * se manda el email, fuera de toda transacción. Si el proceso muere a mitad de
 * camino, el lease vence y otra corrida (u otra réplica) la retoma.
 * SKIP LOCKED permite varias réplicas sin que dos tomen la misma fila.
 */
export async function dispatchDue(pool: Pool, mailer: Mailer, options: DispatchOptions, logger: Logger) {
  const { rows } = await pool.query<ClaimedNotification>(
    `UPDATE notifications n
        SET attempts = n.attempts + 1,
            next_attempt_at = now() + make_interval(secs => $2)
       FROM (SELECT id FROM notifications
              WHERE status = 'pending' AND next_attempt_at <= now()
              ORDER BY next_attempt_at
              LIMIT $1
              FOR UPDATE SKIP LOCKED) due
      WHERE n.id = due.id
      RETURNING n.id, n.kind, n.user_id AS "userId", n.event_id AS "eventId", n.payload, n.attempts`,
    [options.batchSize ?? 20, options.leaseSeconds ?? 120],
  )

  const result = { sent: 0, retried: 0, failed: 0 }
  for (const n of rows) {
    try {
      const { rows: users } = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [n.userId])
      if (!users[0]) throw new MissingDataError('todavía no se conoce el email del usuario')

      let event: EventInfo | null = null
      if (n.eventId) {
        const { rows: events } = await pool.query<EventInfo>(
          `SELECT id, title, venue_name AS "venueName", city, starts_at AS "startsAt" FROM events WHERE id = $1`,
          [n.eventId],
        )
        event = events[0] ?? null
      }

      const email = await renderEmail(
        { kind: n.kind, payload: n.payload, event },
        { timezone: options.timezone, ticketSecret: options.ticketSecret },
      )
      await mailer.send({ ...email, to: users[0].email, messageId: `<${n.id}@ticketflow.test>` })
      await pool.query(`UPDATE notifications SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`, [n.id])
      result.sent++
    } catch (err) {
      const message = (err as Error).message
      if (n.attempts >= options.maxAttempts) {
        await pool.query(`UPDATE notifications SET status = 'failed', last_error = $2 WHERE id = $1`, [n.id, message])
        logger.error({ notificationId: n.id, kind: n.kind, attempts: n.attempts, err: message }, 'notificación descartada')
        result.failed++
      } else {
        const delay = backoffSeconds(n.attempts, options.retryBaseSeconds)
        await pool.query(
          `UPDATE notifications SET next_attempt_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1`,
          [n.id, delay, message],
        )
        logger.warn({ notificationId: n.id, kind: n.kind, attempt: n.attempts, retryIn: delay, err: message }, 'envío fallido, se reintenta')
        result.retried++
      }
    }
  }
  return result
}
