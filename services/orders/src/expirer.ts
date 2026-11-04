import { enqueueOutbox, withTransaction, type Pool } from '@ticketflow/common'
import { OrderEvents } from './projection'
import { idempotencyRepository, orderRepository, releaseSeatsOf } from './repository'

/**
 * Vence las reservas no pagadas y libera sus asientos.
 *
 * Aunque este job se atrase, nadie se queda sin poder comprar: un asiento con
 * la reserva vencida ya cuenta como disponible (ver TAKEABLE en el repositorio).
 * El job existe para cerrar las órdenes y avisar al resto con order.expired.
 */
export async function expireOrders(pool: Pool, batchSize = 100): Promise<number> {
  return withTransaction(pool, async (tx) => {
    const expired = await orderRepository.expireDue(tx, batchSize)
    await releaseSeatsOf(
      tx,
      expired.map((o) => o.id),
    )
    for (const { id, userId, eventId } of expired) {
      await enqueueOutbox(tx, {
        type: OrderEvents.expired,
        aggregateId: id,
        payload: { orderId: id, userId, eventId },
      })
    }
    return expired.length
  })
}

export async function purgeIdempotencyKeys(pool: Pool, ttlHours: number): Promise<number> {
  return idempotencyRepository.deleteOlderThan(pool, ttlHours)
}
