import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from '@ticketflow/common'
import { handleDomainEvent } from '../src/projection'
import { domainEvent, makeApp, makeUser, resetData, seedEvent, setupDb, silentLogger, type SeededEvent, type TestUser } from './helpers'

/** Lado de orders de la saga de compra: qué pasa cuando payments avisa un cobro. */

type App = Awaited<ReturnType<typeof makeApp>>

let pool: Pool
let app: App
let user: TestUser
let event: SeededEvent

beforeAll(async () => {
  pool = await setupDb()
  user = await makeUser()
})

beforeEach(async () => {
  await resetData(pool)
  app = await makeApp(pool)
  event = await seedEvent(pool, [{ rows: 1, seatsPerRow: 5 }])
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await pool.end()
})

async function createOrder(numbers = [1, 2]) {
  const res = await app.inject({
    method: 'POST',
    url: '/orders',
    headers: { authorization: `Bearer ${user.token}`, 'idempotency-key': randomUUID() },
    payload: { eventId: event.id, seats: numbers.map((number) => ({ sectionId: event.sections[0]!.id, row: 1, number })) },
  })
  return res.json()
}

const paymentSucceeded = (orderId: string, messageId?: string) =>
  handleDomainEvent(pool, domainEvent('payment.succeeded', { orderId, paymentId: randomUUID() }, messageId), silentLogger)

const orderRow = async (id: string) =>
  (await pool.query(`SELECT status, paid_at, payment_id FROM orders WHERE id = $1`, [id])).rows[0]
const seatStatuses = async () =>
  (await pool.query(`SELECT status FROM seats ORDER BY number`)).rows.map((r) => r.status)
const outbox = async () =>
  (await pool.query(`SELECT type, payload FROM outbox ORDER BY id`)).rows as { type: string; payload: Record<string, unknown> }[]

describe('pago aprobado a tiempo', () => {
  it('la orden queda pagada y los asientos pasan a vendidos', async () => {
    const order = await createOrder()
    await paymentSucceeded(order.id)

    expect(await orderRow(order.id)).toMatchObject({ status: 'paid', paid_at: expect.any(Date) })
    expect(await seatStatuses()).toEqual(['sold', 'sold', 'available', 'available', 'available'])
    expect((await outbox()).map((m) => m.type)).toEqual(['order.created', 'order.paid'])
  })

  it('un aviso de pago duplicado no tiene efecto', async () => {
    const order = await createOrder()
    const messageId = randomUUID()
    await paymentSucceeded(order.id, messageId)
    await paymentSucceeded(order.id, messageId)
    await paymentSucceeded(order.id) // mismo pago, otro mensaje: tampoco hace nada

    expect((await outbox()).filter((m) => m.type === 'order.paid')).toHaveLength(1)
  })

  it('una orden pagada no se puede cancelar desde la API', async () => {
    const order = await createOrder()
    await paymentSucceeded(order.id)

    const res = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${user.token}` },
    })
    expect(res.json().error.code).toBe('ORDER_NOT_CANCELLABLE')
  })
})

describe('compensación: el pago llega tarde', () => {
  it('si la reserva venció, rechaza el pago, vence la orden y libera los asientos', async () => {
    const order = await createOrder()
    await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second'`)
    await pool.query(`UPDATE seats SET held_until = now() - interval '1 second' WHERE status = 'held'`)

    await paymentSucceeded(order.id)

    expect((await orderRow(order.id)).status).toBe('expired')
    expect(await seatStatuses()).toEqual(Array(5).fill('available'))
    const messages = await outbox()
    expect(messages.map((m) => m.type)).toEqual(['order.created', 'order.expired', 'order.payment_rejected'])
    expect(messages[2]!.payload).toMatchObject({ orderId: order.id, reason: 'order_expired' })
  })

  it('si la orden fue cancelada, rechaza el pago', async () => {
    const order = await createOrder()
    await app.inject({ method: 'POST', url: `/orders/${order.id}/cancel`, headers: { authorization: `Bearer ${user.token}` } })

    await paymentSucceeded(order.id)

    expect((await orderRow(order.id)).status).toBe('cancelled')
    expect((await outbox()).at(-1)).toMatchObject({ type: 'order.payment_rejected', payload: { reason: 'order_cancelled' } })
  })
})

describe('cancelación del evento', () => {
  it('cancela también las órdenes pagadas, marcándolas para reembolso', async () => {
    const paid = await createOrder([1])
    await paymentSucceeded(paid.id)
    const pending = await createOrder([2])

    await handleDomainEvent(pool, domainEvent('event.cancelled', { eventId: event.id }), silentLogger)

    const cancellations = (await outbox()).filter((m) => m.type === 'order.cancelled')
    expect(cancellations.map((m) => m.payload).sort((a, b) => Number(a.wasPaid) - Number(b.wasPaid))).toEqual([
      { orderId: pending.id, eventId: event.id, reason: 'event_cancelled', wasPaid: false },
      { orderId: paid.id, eventId: event.id, reason: 'event_cancelled', wasPaid: true },
    ])
  })
})
