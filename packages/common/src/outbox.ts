import { withTransaction, type Pool, type Queryable } from './db'
import type { MessagePublisher } from './rabbit'

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
  await db.query(`INSERT INTO outbox (type, aggregate_id, payload) VALUES ($1, $2, $3)`, [
    msg.type,
    msg.aggregateId,
    JSON.stringify(msg.payload),
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
        `SELECT id, message_id, type, aggregate_id, payload, created_at
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
          await this.publisher.publish({
            messageId: row.message_id,
            type: row.type,
            aggregateId: row.aggregate_id,
            occurredAt: row.created_at.toISOString(),
            payload: row.payload,
          })
          await tx.query(`UPDATE outbox SET published_at = now() WHERE id = $1`, [row.id])
          published++
        } catch (err) {
          await tx.query(
            `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
            [row.id, (err as Error).message],
          )
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
      this.running = this.processBatch().catch((err) =>
        this.logger.error({ err }, 'error en el relay del outbox'),
      )
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
