import type { Queryable } from '@ticketflow/common'

export type OrderStatus = 'pending_payment' | 'paid' | 'expired' | 'cancelled'

export interface SeatRef {
  sectionId: string
  row: number
  number: number
}

export interface LockedSeat extends SeatRef {
  id: string
  sectionName: string
  priceCents: number
  /** Libre, o retenido por una orden cuya reserva ya venció. */
  takeable: boolean
}

export interface OrderItem extends SeatRef {
  sectionName: string
  priceCents: number
}

export interface Order {
  id: string
  userId: string
  eventId: string
  status: OrderStatus
  totalCents: number
  currency: string
  expiresAt: string
  createdAt: string
  paidAt: string | null
  items: OrderItem[]
}

export interface EventProjection {
  id: string
  status: 'published' | 'cancelled'
  startsAt: Date | null
  currency: string | null
}

/** Un asiento retenido cuya reserva venció cuenta como libre aunque el job todavía no lo haya liberado. */
const TAKEABLE = `(s.status = 'available' OR (s.status = 'held' AND s.held_until <= now()))`

const ORDER_COLUMNS = `o.id, o.user_id AS "userId", o.event_id AS "eventId", o.status,
  o.total_cents AS "totalCents", o.currency, o.expires_at AS "expiresAt", o.created_at AS "createdAt",
  o.paid_at AS "paidAt"`

type OrderRow = Omit<Order, 'items' | 'expiresAt' | 'createdAt' | 'paidAt'> & {
  expiresAt: Date
  createdAt: Date
  paidAt: Date | null
}

async function withItems(db: Queryable, rows: OrderRow[]): Promise<Order[]> {
  if (rows.length === 0) return []
  const { rows: items } = await db.query<OrderItem & { orderId: string }>(
    `SELECT order_id AS "orderId", section_id AS "sectionId", section_name AS "sectionName",
            row, number, price_cents AS "priceCents"
       FROM order_items WHERE order_id = ANY($1)
      ORDER BY section_name, row, number`,
    [rows.map((r) => r.id)],
  )
  return rows.map((r) => ({
    ...r,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
    items: items.filter((i) => i.orderId === r.id).map(({ orderId: _, ...item }) => item),
  }))
}

export const eventRepository = {
  async find(db: Queryable, id: string): Promise<EventProjection | null> {
    const { rows } = await db.query<EventProjection>(
      `SELECT id, status, starts_at AS "startsAt", currency FROM events WHERE id = $1`,
      [id],
    )
    return rows[0] ?? null
  },
}

export const seatRepository = {
  /**
   * Bloquea (FOR UPDATE) los asientos pedidos, SIEMPRE en el mismo orden (por id).
   *
   * - El lock hace que dos compras del mismo asiento se serialicen: la segunda
   *   espera a que la primera termine y después ve el asiento ya tomado.
   * - El orden fijo evita deadlocks: si A pide [1, 2] y B pide [2, 1], los dos
   *   intentan bloquear primero el 1, así que nunca quedan esperándose mutuamente.
   */
  async lockForPurchase(db: Queryable, eventId: string, seats: SeatRef[]): Promise<LockedSeat[]> {
    const { rows } = await db.query<LockedSeat>(
      `SELECT s.id, s.section_id AS "sectionId", s.row, s.number,
              sec.name AS "sectionName", sec.price_cents AS "priceCents",
              ${TAKEABLE} AS takeable
         FROM seats s
         JOIN sections sec ON sec.id = s.section_id
        WHERE s.event_id = $1
          AND (s.section_id, s.row, s.number) IN (
                SELECT * FROM unnest($2::uuid[], $3::int[], $4::int[]))
        ORDER BY s.id
        FOR UPDATE OF s`,
      [eventId, seats.map((s) => s.sectionId), seats.map((s) => s.row), seats.map((s) => s.number)],
    )
    return rows
  },

  async hold(db: Queryable, seatIds: string[], orderId: string, until: Date) {
    await db.query(`UPDATE seats SET status = 'held', order_id = $2, held_until = $3 WHERE id = ANY($1)`, [
      seatIds,
      orderId,
      until,
    ])
  },

  async availability(db: Queryable, eventId: string) {
    const { rows } = await db.query<{ id: string; name: string; priceCents: number; total: number; available: number }>(
      `SELECT sec.id, sec.name, sec.price_cents AS "priceCents",
              count(*)::int AS total,
              count(*) FILTER (WHERE ${TAKEABLE})::int AS available
         FROM sections sec
         JOIN seats s ON s.section_id = sec.id
        WHERE sec.event_id = $1
        GROUP BY sec.id
        ORDER BY sec.position`,
      [eventId],
    )
    return rows
  },

  async seatMap(db: Queryable, eventId: string, sectionId: string) {
    const { rows } = await db.query<{ row: number; number: number; available: boolean }>(
      `SELECT s.row, s.number, ${TAKEABLE} AS available
         FROM seats s
        WHERE s.event_id = $1 AND s.section_id = $2
        ORDER BY s.row, s.number`,
      [eventId, sectionId],
    )
    return rows
  },
}

/** Libera los asientos retenidos por estas órdenes (solo los que siguen siendo suyos). */
export async function releaseSeatsOf(db: Queryable, orderIds: string[]) {
  if (orderIds.length === 0) return
  await db.query(
    `UPDATE seats SET status = 'available', order_id = NULL, held_until = NULL
      WHERE order_id = ANY($1) AND status = 'held'`,
    [orderIds],
  )
}

export const orderRepository = {
  async insert(
    db: Queryable,
    data: { userId: string; eventId: string; totalCents: number; currency: string; holdSeconds: number },
  ): Promise<{ id: string; expiresAt: Date }> {
    const { rows } = await db.query<{ id: string; expiresAt: Date }>(
      `INSERT INTO orders (user_id, event_id, total_cents, currency, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
       RETURNING id, expires_at AS "expiresAt"`,
      [data.userId, data.eventId, data.totalCents, data.currency, data.holdSeconds],
    )
    return rows[0]!
  },

  async insertItems(db: Queryable, orderId: string, seats: LockedSeat[]) {
    await db.query(
      `INSERT INTO order_items (order_id, seat_id, section_id, section_name, row, number, price_cents)
       SELECT $1, * FROM unnest($2::bigint[], $3::uuid[], $4::text[], $5::int[], $6::int[], $7::int[])`,
      [
        orderId,
        seats.map((s) => s.id),
        seats.map((s) => s.sectionId),
        seats.map((s) => s.sectionName),
        seats.map((s) => s.row),
        seats.map((s) => s.number),
        seats.map((s) => s.priceCents),
      ],
    )
  },

  async findById(db: Queryable, id: string, { forUpdate = false } = {}): Promise<Order | null> {
    const { rows } = await db.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    )
    return rows[0] ? (await withItems(db, rows))[0]! : null
  },

  async listByUser(db: Queryable, userId: string): Promise<Order[]> {
    const { rows } = await db.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 50`,
      [userId],
    )
    return withItems(db, rows)
  },

  async setStatus(db: Queryable, id: string, status: OrderStatus) {
    await db.query(`UPDATE orders SET status = $2, updated_at = now() WHERE id = $1`, [id, status])
  },

  /**
   * Marca como vencidas las órdenes pendientes cuyo plazo pasó.
   * SKIP LOCKED: si hay varias réplicas, cada una toma órdenes distintas, y
   * no se pisa con una orden que en este momento se está pagando o cancelando.
   */
  async expireDue(db: Queryable, limit: number) {
    const { rows } = await db.query<{ id: string; userId: string; eventId: string }>(
      `UPDATE orders o
          SET status = 'expired', updated_at = now()
         FROM (SELECT id FROM orders
                WHERE status = 'pending_payment' AND expires_at <= now()
                ORDER BY expires_at
                LIMIT $1
                FOR UPDATE SKIP LOCKED) due
        WHERE o.id = due.id
        RETURNING o.id, o.user_id AS "userId", o.event_id AS "eventId"`,
      [limit],
    )
    return rows
  },
}

export const idempotencyRepository = {
  /**
   * Reserva la clave dentro de la transacción. Si otra request con la misma
   * clave está en curso, este INSERT espera a que termine: si commiteó, hay
   * conflicto y devolvemos su respuesta; si falló, la clave queda libre.
   */
  async claim(db: Queryable, userId: string, key: string, requestHash: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response)
       VALUES ($1, $2, $3, 0, 'null') ON CONFLICT DO NOTHING`,
      [userId, key, requestHash],
    )
    return rowCount === 1
  },

  async find(db: Queryable, userId: string, key: string) {
    const { rows } = await db.query<{ requestHash: string; statusCode: number; response: unknown }>(
      `SELECT request_hash AS "requestHash", status_code AS "statusCode", response
         FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
      [userId, key],
    )
    return rows[0] ?? null
  },

  async saveResponse(db: Queryable, userId: string, key: string, statusCode: number, response: unknown) {
    await db.query(`UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2`, [
      userId,
      key,
      statusCode,
      JSON.stringify(response),
    ])
  },

  async deleteOlderThan(db: Queryable, hours: number) {
    const { rowCount } = await db.query(
      `DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`,
      [hours],
    )
    return rowCount ?? 0
  },
}
