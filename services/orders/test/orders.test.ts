import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from '@ticketflow/common'
import { expireOrders } from '../src/expirer'
import { makeApp, makeUser, resetData, seedEvent, setupDb, type SeededEvent, type TestUser } from './helpers'

type App = Awaited<ReturnType<typeof makeApp>>

let pool: Pool
let app: App
let ana: TestUser
let beto: TestUser
let admin: TestUser
let event: SeededEvent

beforeAll(async () => {
  pool = await setupDb()
  ;[ana, beto, admin] = await Promise.all([makeUser(), makeUser(), makeUser('admin')])
})

beforeEach(async () => {
  await resetData(pool)
  app = await makeApp(pool)
  event = await seedEvent(pool, [
    { name: 'Campo', priceCents: 10_000, rows: 5, seatsPerRow: 10 },
    { name: 'Platea', priceCents: 25_000, rows: 2, seatsPerRow: 5 },
  ])
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await pool.end()
})

const seat = (section: number, row: number, number: number) => ({ sectionId: event.sections[section]!.id, row, number })

const buy = (
  user: TestUser,
  seats: { sectionId: string; row: number; number: number }[],
  key: string = randomUUID(),
  eventId = event.id,
) =>
  app.inject({
    method: 'POST',
    url: '/orders',
    headers: { authorization: `Bearer ${user.token}`, 'idempotency-key': key },
    payload: { eventId, seats },
  })

const seatState = async (s: { sectionId: string; row: number; number: number }) =>
  (
    await pool.query(
      `SELECT status, order_id FROM seats WHERE section_id = $1 AND row = $2 AND number = $3`,
      [s.sectionId, s.row, s.number],
    )
  ).rows[0]

const outboxTypes = async () => (await pool.query(`SELECT type FROM outbox ORDER BY id`)).rows.map((r) => r.type)

describe('comprar', () => {
  it('reserva los asientos, calcula el total y deja la orden pendiente de pago', async () => {
    const res = await buy(ana, [seat(0, 1, 1), seat(0, 1, 2), seat(1, 1, 1)])

    expect(res.statusCode).toBe(201)
    const order = res.json()
    expect(order).toMatchObject({ status: 'pending_payment', totalCents: 45_000, currency: 'ARS', userId: ana.id })
    expect(order.items).toHaveLength(3)
    expect(new Date(order.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000)

    expect(await seatState(seat(0, 1, 1))).toEqual({ status: 'held', order_id: order.id })
    expect(await outboxTypes()).toEqual(['order.created'])
  })

  it('un asiento reservado no se puede volver a comprar', async () => {
    await buy(ana, [seat(0, 1, 1)])
    const res = await buy(beto, [seat(0, 1, 2), seat(0, 1, 1)])

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatchObject({ code: 'SEATS_UNAVAILABLE', details: { seats: [seat(0, 1, 1)] } })
    // Todo o nada: el asiento libre del pedido tampoco quedó reservado.
    expect((await seatState(seat(0, 1, 2))).status).toBe('available')
  })

  it('valida los asientos pedidos', async () => {
    expect((await buy(ana, [seat(0, 99, 1)])).json().error.code).toBe('SEAT_NOT_FOUND')
    expect((await buy(ana, [seat(0, 1, 1), seat(0, 1, 1)])).json().error.code).toBe('DUPLICATE_SEATS')

    const tooMany = Array.from({ length: 11 }, (_, i) => seat(0, 1, (i % 10) + 1)).map((s, i) =>
      i === 10 ? seat(0, 2, 1) : s,
    )
    expect((await buy(ana, tooMany)).json().error.code).toBe('TOO_MANY_SEATS')
  })

  it('no vende entradas de eventos inexistentes, cancelados o que ya empezaron', async () => {
    expect((await buy(ana, [seat(0, 1, 1)], undefined, randomUUID())).statusCode).toBe(404)

    const past = await seedEvent(pool, [{ rows: 1, seatsPerRow: 1 }], new Date(Date.now() - 1000).toISOString())
    const res = await buy(ana, [{ sectionId: past.sections[0]!.id, row: 1, number: 1 }], undefined, past.id)
    expect(res.json().error.code).toBe('EVENT_NOT_ON_SALE')
  })

  it('exige Idempotency-Key y autenticación', async () => {
    const noKey = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${ana.token}` },
      payload: { eventId: event.id, seats: [seat(0, 1, 1)] },
    })
    expect(noKey.statusCode).toBe(400)

    const noAuth = await app.inject({ method: 'POST', url: '/orders', payload: {} })
    expect(noAuth.statusCode).toBe(401)
  })
})

describe('idempotencia', () => {
  it('reintentar con la misma clave devuelve la misma orden sin crear otra', async () => {
    const key = randomUUID()
    const first = await buy(ana, [seat(0, 1, 1)], key)
    const retry = await buy(ana, [seat(0, 1, 1)], key)

    expect(retry.statusCode).toBe(201)
    expect(retry.json()).toEqual(first.json())
    expect(retry.headers['idempotent-replayed']).toBe('true')
    expect((await pool.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n).toBe(1)
  })

  it('dos requests simultáneas con la misma clave crean una sola orden', async () => {
    const key = randomUUID()
    const results = await Promise.all(Array.from({ length: 5 }, () => buy(ana, [seat(0, 1, 1)], key)))

    expect(results.every((r) => r.statusCode === 201)).toBe(true)
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1)
    expect((await pool.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n).toBe(1)
  })

  it('la misma clave con otro pedido es un error del cliente', async () => {
    const key = randomUUID()
    await buy(ana, [seat(0, 1, 1)], key)
    const res = await buy(ana, [seat(0, 1, 2)], key)

    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('las claves son por usuario', async () => {
    const key = randomUUID()
    expect((await buy(ana, [seat(0, 1, 1)], key)).statusCode).toBe(201)
    expect((await buy(beto, [seat(0, 1, 2)], key)).statusCode).toBe(201)
  })

  it('si la compra falla, la clave queda libre para reintentar', async () => {
    await buy(beto, [seat(0, 1, 1)])
    const key = randomUUID()

    expect((await buy(ana, [seat(0, 1, 1)], key)).statusCode).toBe(409)
    expect((await buy(ana, [seat(0, 1, 2)], key)).statusCode).toBe(201)
  })
})

describe('consultar y cancelar', () => {
  it('cada usuario ve solo sus órdenes', async () => {
    const order = (await buy(ana, [seat(0, 1, 1)])).json()
    const get = (user: TestUser) =>
      app.inject({ method: 'GET', url: `/orders/${order.id}`, headers: { authorization: `Bearer ${user.token}` } })

    expect((await get(ana)).statusCode).toBe(200)
    expect((await get(admin)).statusCode).toBe(200)
    expect((await get(beto)).statusCode).toBe(404)

    const mine = await app.inject({ method: 'GET', url: '/orders', headers: { authorization: `Bearer ${beto.token}` } })
    expect(mine.json().items).toHaveLength(0)
  })

  it('cancelar libera los asientos y emite order.cancelled', async () => {
    const order = (await buy(ana, [seat(0, 1, 1)])).json()
    const cancel = (user: TestUser) =>
      app.inject({ method: 'POST', url: `/orders/${order.id}/cancel`, headers: { authorization: `Bearer ${user.token}` } })

    expect((await cancel(beto)).statusCode).toBe(404)
    expect((await cancel(ana)).json().status).toBe('cancelled')
    expect((await cancel(ana)).json().error.code).toBe('ORDER_NOT_CANCELLABLE')

    expect((await seatState(seat(0, 1, 1))).status).toBe('available')
    expect(await outboxTypes()).toEqual(['order.created', 'order.cancelled'])
    expect((await buy(beto, [seat(0, 1, 1)])).statusCode).toBe(201)
  })
})

describe('vencimiento de reservas', () => {
  const expireAll = () => pool.query(`UPDATE orders SET expires_at = now() - interval '1 second'`).then(() =>
    pool.query(`UPDATE seats SET held_until = now() - interval '1 second' WHERE status = 'held'`),
  )

  it('el job vence las órdenes impagas, libera asientos y emite order.expired', async () => {
    const order = (await buy(ana, [seat(0, 1, 1), seat(0, 1, 2)])).json()
    await expireAll()

    expect(await expireOrders(pool)).toBe(1)
    expect(await expireOrders(pool)).toBe(0) // idempotente

    const { rows } = await pool.query(`SELECT status FROM orders WHERE id = $1`, [order.id])
    expect(rows[0].status).toBe('expired')
    expect((await seatState(seat(0, 1, 1))).status).toBe('available')
    expect(await outboxTypes()).toEqual(['order.created', 'order.expired'])
  })

  it('un asiento con la reserva vencida se puede comprar aunque el job no haya pasado', async () => {
    const old = (await buy(ana, [seat(0, 1, 1)])).json()
    await expireAll()

    const res = await buy(beto, [seat(0, 1, 1)])
    expect(res.statusCode).toBe(201)

    // Cuando el job corre después, vence la orden vieja pero NO le saca el asiento al nuevo dueño.
    await expireOrders(pool)
    expect(await seatState(seat(0, 1, 1))).toEqual({ status: 'held', order_id: res.json().id })
    const { rows } = await pool.query(`SELECT status FROM orders WHERE id = $1`, [old.id])
    expect(rows[0].status).toBe('expired')
  })
})

describe('disponibilidad', () => {
  it('resume por sector y muestra el mapa de asientos', async () => {
    await buy(ana, [seat(1, 1, 1), seat(1, 2, 5)])

    const summary = (await app.inject({ method: 'GET', url: `/availability/${event.id}` })).json()
    expect(summary.sections).toEqual([
      expect.objectContaining({ name: 'Campo', total: 50, available: 50 }),
      expect.objectContaining({ name: 'Platea', total: 10, available: 8 }),
    ])

    const map = (
      await app.inject({ method: 'GET', url: `/availability/${event.id}/sections/${event.sections[1]!.id}` })
    ).json()
    expect(map.rows).toHaveLength(2)
    expect(map.rows[0].seats[0]).toEqual({ number: 1, available: false })
    expect(map.rows[0].seats[1]).toEqual({ number: 2, available: true })
  })
})
