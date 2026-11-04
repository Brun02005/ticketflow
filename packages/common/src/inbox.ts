import { withTransaction, type Pool, type PoolClient } from './db'

/**
 * Consumidor idempotente (patrón Inbox).
 *
 * RabbitMQ garantiza at-least-once: el mismo mensaje puede llegar dos veces
 * (reintento, reconexión, el relay que publicó dos veces). Registramos el
 * messageId en `processed_messages` en la MISMA transacción que el efecto:
 * si ya estaba, el mensaje se descarta; si la transacción falla, no queda
 * registrado y el reintento lo vuelve a procesar.
 *
 * Devuelve false si el mensaje era un duplicado.
 */
export async function processOnce(
  pool: Pool,
  messageId: string,
  fn: (tx: PoolClient) => Promise<void>,
): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [messageId],
    )
    if (rowCount === 0) return false
    await fn(tx)
    return true
  })
}
