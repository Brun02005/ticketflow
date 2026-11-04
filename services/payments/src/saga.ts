import {
  type DomainEvent,
  PoisonMessageError,
  type Pool,
  type PoolClient,
  processOnce,
  type Static,
  type TSchema,
  Type,
  Value,
} from '@ticketflow/common'
import { findPaymentByOrder, setPaymentStatus } from './payments'

/**
 * Lado de pagos de la saga de compra. Reacciona a lo que pasa con las órdenes:
 *
 *   order.created            → se crea el pago, esperando que el cliente pague
 *   order.expired/cancelled  → si no se pagó, se anula; si se pagó, se reembolsa
 *   order.payment_rejected   → orders no pudo aceptar un pago (llegó tarde): se reembolsa
 */

const OrderCreated = Type.Object({
  id: Type.String(),
  userId: Type.String(),
  eventId: Type.String(),
  totalCents: Type.Integer({ minimum: 0 }),
  currency: Type.String(),
  expiresAt: Type.String(),
})
const OrderClosed = Type.Object({ orderId: Type.String() })

function parse<T extends TSchema>(schema: T, event: DomainEvent): Static<T> {
  if (!Value.Check(schema, event.payload)) {
    throw new PoisonMessageError(
      `${event.type} con payload inválido: ${Value.Errors(schema, event.payload)[0]?.message}`,
    )
  }
  return event.payload as Static<T>
}

interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

export async function handleOrderMessage(pool: Pool, event: DomainEvent, logger: Logger): Promise<void> {
  let apply: (tx: PoolClient) => Promise<void>
  switch (event.type) {
    case 'order.created': {
      const order = parse(OrderCreated, event)
      apply = async (tx) => {
        await tx.query(
          `INSERT INTO payments (order_id, user_id, event_id, amount_cents, currency, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (order_id) DO NOTHING`,
          [order.id, order.userId, order.eventId, order.totalCents, order.currency, new Date(order.expiresAt)],
        )
      }
      break
    }
    case 'order.expired':
    case 'order.cancelled':
    case 'order.payment_rejected': {
      const { orderId } = parse(OrderClosed, event)
      apply = (tx) => closePayment(tx, orderId, event.type, logger)
      break
    }
    default:
      return
  }

  const processed = await processOnce(pool, event.messageId, apply)
  logger.info({ messageId: event.messageId, type: event.type, duplicate: !processed }, 'mensaje de órdenes procesado')
}

async function closePayment(tx: PoolClient, orderId: string, reason: string, logger: Logger) {
  const payment = await findPaymentByOrder(tx, orderId, true)
  if (!payment) return

  switch (payment.status) {
    case 'awaiting_payment':
      await setPaymentStatus(tx, payment.id, 'voided')
      break
    case 'succeeded':
      // Compensación de la saga: hay plata cobrada para una orden que no se va a cumplir.
      await setPaymentStatus(tx, payment.id, 'refund_pending')
      logger.info({ paymentId: payment.id, reason }, 'pago a reembolsar')
      break
    case 'processing':
      // Hay un cobro en vuelo. Si termina aprobado, orders lo rechazará y llegará
      // order.payment_rejected; si falla, queda anulado por vencimiento.
      logger.warn({ paymentId: payment.id, reason }, 'orden cerrada con un cobro en curso')
      break
  }
}
