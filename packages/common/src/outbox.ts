import { type Pool, type Queryable, withTransaction } from './db'
import { outboxPublished, outboxPublishFailures } from './metrics'
import type { MessagePublisher } from './rabbit'
import { captureTraceContext, extractTraceContext, SpanKind, withSpan } from './tracing'

/**
 * Patrón Transactional Outbox.
 *
 * Problema: si un servicio guarda en su base y después publica en RabbitMQ,
 * puede caerse entre los dos pasos y el evento se pierde (o al revés: se
 * publica algo que nunca se commiteó).
 *
 * Solución: el evento se inserta en la tabla `outbox` dentro de la MISMA
 * transacción que el cambio de negocio. Un proceso aparte (el relay) lee la
 * tabla y publica. Garantía resultante: at-least-once. Los consumidores
 * descartan duplicados usando `messageId`.
 *
 * Cada servicio crea su propia tabla `outbox` en sus migraciones.
 */
export interface OutboxMessage {
  type: string
  aggregateId: string
  payload: unknown
}

export async function enqueueOutbox(db: Queryable, msg: OutboxMessage): Promise<void> {
  // Guardamos el contexto de la traza actual para que el mensaje la continúe (ver tracing.ts).
  await db.query(`INSERT INTO outbox (type, aggregate_id, payload, headers) VALUES ($1, $2, $3, $4)`, [
    msg.type,
    msg.aggregateId,
    JSON.stringify(msg.payload),
    JSON.stringify(captureTraceContext()),
  ])
}

interface RelayLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

interface OutboxRow {
  id: string
  message_id: string
  type: string
  aggregate_id: string
  payload: unknown
  headers: Record<string, string>
  created_at: Date
}

export interface OutboxRelayOptions {
  intervalMs?: number
  batchSize?: number
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<unknown> | null = null
  private stopped = false
  private readonly intervalMs: number
  private readonly batchSize: number

  constructor(
    private readonly pool: Pool,
    private readonly publisher: MessagePublisher,
    private readonly logger: RelayLogger,
    options: OutboxRelayOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1000
    this.batchSize = options.batchSize ?? 100
  }

  /**
   * Publica un lote de mensajes pendientes, en orden. Devuelve cuántos publicó.
   *
   * `FOR UPDATE SKIP LOCKED` permite correr varias réplicas del relay a la vez:
   * cada una toma filas distintas en lugar de bloquearse o duplicar trabajo.
   */
  async processBatch(): Promise<number> {
    return withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<OutboxRow>(
        `SELECT id, message_id, type, aggregate_id, payload, headers, created_at
           FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      )

      let published = 0
      for (const row of rows) {
        try {
          // Span "publish" hijo de la request que originó el evento, aunque se publique después.
          await withSpan(
            `publish ${row.type}`,
            {
              kind: SpanKind.PRODUCER,
              parent: extractTraceContext(row.headers),
              attributes: { 'messaging.system': 'rabbitmq', 'messaging.message.id': row.message_id },
            },
            () =>
              this.publisher.publish(
                {
                  messageId: row.message_id,
                  type: row.type,
                  aggregateId: row.aggregate_id,
                  occurredAt: row.created_at.toISOString(),
                  payload: row.payload,
                },
                captureTraceContext(),
              ),
          )
          await tx.query(`UPDATE outbox SET published_at = now() WHERE id = $1`, [row.id])
          outboxPublished.inc({ type: row.type })
          published++
        } catch (err) {
          outboxPublishFailures.inc()
          await tx.query(`UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [
            row.id,
            (err as Error).message,
          ])
          this.logger.warn({ err: (err as Error).message, outboxId: row.id }, 'no se pudo publicar, se reintenta')
          // Cortamos el lote para no publicar mensajes posteriores fuera de orden.
          break
        }
      }
      return published
    })
  }

  start() {
    this.stopped = false
    const tick = async () => {
      if (this.stopped) return
      this.running = this.processBatch().catch((err) => this.logger.error({ err }, 'error en el relay del outbox'))
      const published = await this.running
      if (this.stopped) return
      // Si el lote vino lleno probablemente hay más pendientes: seguimos sin esperar.
      const delay = published === this.batchSize ? 0 : this.intervalMs
      this.timer = setTimeout(tick, delay)
    }
    void tick()
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.running
  }
}
