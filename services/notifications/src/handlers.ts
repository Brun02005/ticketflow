import {
  PoisonMessageError,
  Type,
  Value,
  processOnce,
  type DomainEvent,
  type Pool,
  type PoolClient,
  type Static,
  type TSchema,
} from '@ticketflow/common'

export type NotificationKind = 'welcome' | 'tickets' | 'payment_failed' | 'order_expired' | 'event_cancelled' | 'refund'

/** Routing keys que consume el worker. */
export const BINDINGS = [
  'user.registered',
  'event.published',
  'order.paid',
  'order.expired',
  'order.cancelled',
  'payment.failed',
  'payment.refunded',
]

// Contratos (lector tolerante: solo los campos que se usan).
const UserRegistered = Type.Object({ userId: Type.String(), email: Type.String() })
const EventPublished = Type.Object({
  id: Type.String(),
  title: Type.String(),
  venueName: Type.String(),
  city: Type.String(),
  startsAt: Type.String(),
})
const OrderItem = Type.Object({
  sectionId: Type.String(),
  sectionName: Type.String(),
  row: Type.Integer(),
  number: Type.Integer(),
  priceCents: Type.Integer(),
})
const OrderPaid = Type.Object({
  id: Type.String(),
  userId: Type.String(),
  eventId: Type.String(),
  totalCents: Type.Integer(),
  currency: Type.String(),
  items: Type.Array(OrderItem, { minItems: 1 }),
})
const OrderExpired = Type.Object({ orderId: Type.String(), userId: Type.String(), eventId: Type.String() })
const OrderCancelled = Type.Object({
  orderId: Type.String(),
  userId: Type.String(),
  eventId: Type.String(),
  reason: Type.String(),
  wasPaid: Type.Optional(Type.Boolean()),
})
const PaymentFailed = Type.Object({
  orderId: Type.String(),
  userId: Type.String(),
  eventId: Type.String(),
  reason: Type.Union([Type.String(), Type.Null()]),
})
const PaymentRefunded = Type.Object({
  paymentId: Type.String(),
  orderId: Type.String(),
  userId: Type.String(),
  eventId: Type.String(),
  amountCents: Type.Integer(),
  currency: Type.String(),
})

function parse<T extends TSchema>(schema: T, event: DomainEvent): Static<T> {
  if (!Value.Check(schema, event.payload)) {
    throw new PoisonMessageError(`${event.type} con payload inválido: ${Value.Errors(schema, event.payload)[0]?.message}`)
  }
  return event.payload as Static<T>
}

interface Intent {
  dedupeKey: string
  kind: NotificationKind
  userId: string
  eventId: string | null
  payload: unknown
}

/** Registra la intención de enviar un email. El mismo hecho de negocio nunca genera dos. */
async function enqueue(tx: PoolClient, n: Intent) {
  await tx.query(
    `INSERT INTO notifications (dedupe_key, kind, user_id, event_id, payload)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
    [n.dedupeKey, n.kind, n.userId, n.eventId, JSON.stringify(n.payload)],
  )
}

interface Logger {
  info(obj: object, msg?: string): void
}

export async function handleMessage(pool: Pool, event: DomainEvent, logger: Logger): Promise<void> {
  let apply: (tx: PoolClient) => Promise<void>

  switch (event.type) {
    case 'user.registered': {
      const u = parse(UserRegistered, event)
      apply = async (tx) => {
        await tx.query(
          `INSERT INTO users (id, email) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
          [u.userId, u.email],
        )
        await enqueue(tx, { dedupeKey: `welcome:${u.userId}`, kind: 'welcome', userId: u.userId, eventId: null, payload: {} })
      }
      break
    }
    case 'event.published': {
      const e = parse(EventPublished, event)
      apply = async (tx) => {
        await tx.query(
          `INSERT INTO events (id, title, venue_name, city, starts_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [e.id, e.title, e.venueName, e.city, new Date(e.startsAt)],
        )
      }
      break
    }
    case 'order.paid': {
      const o = parse(OrderPaid, event)
      apply = (tx) =>
        enqueue(tx, {
          dedupeKey: `tickets:${o.id}`,
          kind: 'tickets',
          userId: o.userId,
          eventId: o.eventId,
          payload: { orderId: o.id, totalCents: o.totalCents, currency: o.currency, items: o.items },
        })
      break
    }
    case 'order.expired': {
      const o = parse(OrderExpired, event)
      apply = (tx) =>
        enqueue(tx, {
          dedupeKey: `order_expired:${o.orderId}`,
          kind: 'order_expired',
          userId: o.userId,
          eventId: o.eventId,
          payload: { orderId: o.orderId },
        })
      break
    }
    case 'order.cancelled': {
      const o = parse(OrderCancelled, event)
      // Si la canceló el propio usuario, ya lo sabe: solo avisamos cancelaciones del evento.
      if (o.reason !== 'event_cancelled') return
      apply = (tx) =>
        enqueue(tx, {
          dedupeKey: `event_cancelled:${o.orderId}`,
          kind: 'event_cancelled',
          userId: o.userId,
          eventId: o.eventId,
          payload: { orderId: o.orderId, wasPaid: o.wasPaid ?? false },
        })
      break
    }
    case 'payment.failed': {
      const p = parse(PaymentFailed, event)
      apply = (tx) =>
        enqueue(tx, {
          // Cada rechazo es un hecho distinto (el cliente puede reintentar con otra tarjeta).
          dedupeKey: `payment_failed:${event.messageId}`,
          kind: 'payment_failed',
          userId: p.userId,
          eventId: p.eventId,
          payload: { orderId: p.orderId, reason: p.reason },
        })
      break
    }
    case 'payment.refunded': {
      const p = parse(PaymentRefunded, event)
      apply = (tx) =>
        enqueue(tx, {
          dedupeKey: `refund:${p.paymentId}`,
          kind: 'refund',
          userId: p.userId,
          eventId: p.eventId,
          payload: { orderId: p.orderId, amountCents: p.amountCents, currency: p.currency },
        })
      break
    }
    default:
      return
  }

  const processed = await processOnce(pool, event.messageId, apply)
  logger.info({ messageId: event.messageId, type: event.type, duplicate: !processed }, 'mensaje procesado')
}
