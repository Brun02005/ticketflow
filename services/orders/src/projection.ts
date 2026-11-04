import {
  type DomainEvent,
  enqueueOutbox,
  PoisonMessageError,
  type Pool,
  type PoolClient,
  processOnce,
  type Static,
  type TSchema,
  Type,
  Value,
} from '@ticketflow/common'
import { orderRepository, releaseSeatsOf } from './repository'

/**
 * Contratos de los mensajes que consume este servicio.
 *
 * "Tolerant reader": validamos solo los campos que usamos y aceptamos campos
 * extra. Así events-service puede agregar datos al mensaje sin romper a orders.
 */
const EventPublished = Type.Object({
  id: Type.String(),
  title: Type.String(),
  startsAt: Type.String(),
  currency: Type.String(),
  sections: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      priceCents: Type.Integer({ minimum: 0 }),
      rows: Type.Integer({ minimum: 1, maximum: 100 }),
      seatsPerRow: Type.Integer({ minimum: 1, maximum: 200 }),
    }),
    { minItems: 1 },
  ),
})

const EventCancelled = Type.Object({ eventId: Type.String() })

const PaymentSucceeded = Type.Object({ orderId: Type.String(), paymentId: Type.String() })

function parsePayload<T extends TSchema>(schema: T, event: DomainEvent): Static<T> {
  if (!Value.Check(schema, event.payload)) {
    const reason = Value.Errors(schema, event.payload)[0]?.message ?? 'formato inválido'
    throw new PoisonMessageError(`${event.type} con payload inválido: ${reason}`)
  }
  return event.payload as Static<T>
}

export const OrderEvents = {
  created: 'order.created',
  cancelled: 'order.cancelled',
  expired: 'order.expired',
  paid: 'order.paid',
  /** Llegó un pago que la orden ya no puede aceptar: payments tiene que reembolsarlo. */
  paymentRejected: 'order.payment_rejected',
} as const

interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

/** Punto de entrada del consumidor: despacha según el tipo y garantiza idempotencia. */
export async function handleDomainEvent(pool: Pool, event: DomainEvent, logger: Logger): Promise<void> {
  let apply: (tx: PoolClient) => Promise<void>
  switch (event.type) {
    case 'event.published': {
      const payload = parsePayload(EventPublished, event)
      apply = (tx) => applyEventPublished(tx, payload)
      break
    }
    case 'event.cancelled': {
      const payload = parsePayload(EventCancelled, event)
      apply = (tx) => applyEventCancelled(tx, payload.eventId)
      break
    }
    case 'payment.succeeded': {
      const payload = parsePayload(PaymentSucceeded, event)
      apply = (tx) => applyPaymentSucceeded(tx, payload, logger)
      break
    }
    default:
      return // un tipo que no nos interesa: se confirma y se ignora
  }

  const processed = await processOnce(pool, event.messageId, apply)
  logger.info(
    { messageId: event.messageId, type: event.type, aggregateId: event.aggregateId, duplicate: !processed },
    processed ? 'mensaje procesado' : 'mensaje duplicado descartado',
  )
}

/**
 * Crea la proyección del evento y genera su inventario de asientos.
 * Si el evento ya existe (mensaje repetido con otro id, o llegó antes la
 * cancelación) no hace nada: nunca se "revive" un evento cancelado.
 */
async function applyEventPublished(tx: PoolClient, e: Static<typeof EventPublished>) {
  const startsAt = new Date(e.startsAt)
  if (Number.isNaN(startsAt.getTime())) throw new PoisonMessageError('startsAt inválido')

  const { rowCount } = await tx.query(
    `INSERT INTO events (id, title, starts_at, currency, status)
     VALUES ($1, $2, $3, $4, 'published')
     ON CONFLICT (id) DO NOTHING`,
    [e.id, e.title, startsAt, e.currency],
  )
  if (rowCount === 0) return

  for (const [position, s] of e.sections.entries()) {
    await tx.query(`INSERT INTO sections (id, event_id, name, price_cents, position) VALUES ($1, $2, $3, $4, $5)`, [
      s.id,
      e.id,
      s.name,
      s.priceCents,
      position,
    ])
    // Todos los asientos del sector en un solo INSERT: filas × asientos por fila.
    await tx.query(
      `INSERT INTO seats (event_id, section_id, row, number)
       SELECT $1, $2, r, n FROM generate_series(1, $3::int) AS r, generate_series(1, $4::int) AS n`,
      [e.id, s.id, s.rows, s.seatsPerRow],
    )
  }
}

/**
 * Marca el evento como cancelado (o deja una "lápida" si todavía no lo
 * conocíamos, por si event.published llega después) y cancela sus órdenes:
 * las pendientes liberan asientos; las pagadas, además, disparan el reembolso
 * (payments reacciona a order.cancelled con wasPaid = true).
 */
async function applyEventCancelled(tx: PoolClient, eventId: string) {
  await tx.query(
    `INSERT INTO events (id, status) VALUES ($1, 'cancelled')
     ON CONFLICT (id) DO UPDATE SET status = 'cancelled', updated_at = now()`,
    [eventId],
  )
  const { rows } = await tx.query<{ id: string; userId: string; previous: string }>(
    `UPDATE orders o SET status = 'cancelled', updated_at = now()
       FROM (SELECT id, status AS previous FROM orders
              WHERE event_id = $1 AND status IN ('pending_payment', 'paid')
              FOR UPDATE) p
      WHERE o.id = p.id
      RETURNING o.id, o.user_id AS "userId", p.previous`,
    [eventId],
  )
  await releaseSeatsOf(
    tx,
    rows.map((r) => r.id),
  )
  for (const { id, userId, previous } of rows) {
    await enqueueOutbox(tx, {
      type: OrderEvents.cancelled,
      aggregateId: id,
      payload: { orderId: id, userId, eventId, reason: 'event_cancelled', wasPaid: previous === 'paid' },
    })
  }
}

/**
 * Paso de la saga: payments avisa que se cobró una orden.
 *
 * - Si la orden sigue pendiente y dentro de plazo: queda pagada y los
 *   asientos pasan de "retenidos" a "vendidos" (order.paid).
 * - Si venció o se canceló mientras se procesaba el cobro: el pago se rechaza
 *   (order.payment_rejected) y payments lo reembolsa. Esta es la compensación.
 *
 * El FOR UPDATE sobre la orden la serializa con el job de vencimiento y con la
 * cancelación: no puede pagarse y vencerse al mismo tiempo.
 */
async function applyPaymentSucceeded(
  tx: PoolClient,
  { orderId, paymentId }: { orderId: string; paymentId: string },
  logger: Logger,
) {
  const order = await orderRepository.findById(tx, orderId, { forUpdate: true })
  if (!order) {
    logger.warn({ orderId, paymentId }, 'pago de una orden inexistente')
    return
  }
  if (order.status === 'paid') return

  const onTime = order.status === 'pending_payment' && new Date(order.expiresAt).getTime() > Date.now()
  if (onTime) {
    const { rowCount } = await tx.query(
      `UPDATE seats SET status = 'sold', held_until = NULL WHERE order_id = $1 AND status = 'held'`,
      [orderId],
    )
    // Defensa extra: todos los asientos de la orden tienen que seguir siendo suyos.
    if (rowCount === order.items.length) {
      await tx.query(
        `UPDATE orders SET status = 'paid', paid_at = now(), payment_id = $2, updated_at = now() WHERE id = $1`,
        [orderId, paymentId],
      )
      await enqueueOutbox(tx, {
        type: OrderEvents.paid,
        aggregateId: orderId,
        payload: { ...order, status: 'paid', paymentId },
      })
      return
    }
    throw new Error(`la orden ${orderId} perdió asientos antes del pago (${rowCount}/${order.items.length})`)
  }

  if (order.status === 'pending_payment') {
    // Venció pero el job todavía no pasó: la vencemos ahora, en la misma transacción.
    await orderRepository.setStatus(tx, orderId, 'expired')
    await releaseSeatsOf(tx, [orderId])
    await enqueueOutbox(tx, {
      type: OrderEvents.expired,
      aggregateId: orderId,
      payload: { orderId, userId: order.userId, eventId: order.eventId },
    })
  }
  logger.warn({ orderId, paymentId, status: order.status }, 'pago tardío rechazado, se reembolsará')
  await enqueueOutbox(tx, {
    type: OrderEvents.paymentRejected,
    aggregateId: orderId,
    payload: { orderId, paymentId, reason: order.status === 'cancelled' ? 'order_cancelled' : 'order_expired' },
  })
}
