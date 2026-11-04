import { randomUUID } from 'node:crypto'
import type { Pool } from '@ticketflow/common'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeApp, makeUser, resetData, type SeededEvent, seedEvent, setupDb, type TestUser } from './helpers'

/**
 * El corazón del proyecto: muchos compradores pidiendo los mismos asientos a
 * la vez. Pase lo que pase, un asiento nunca puede quedar en dos órdenes.
 */

type App = Awaited<ReturnType<typeof makeApp>>

let pool: Pool
let app: App
let event: SeededEvent

beforeAll(async () => {
  pool = await setupDb()
})

beforeEach(async () => {
  await resetData(pool)
  app = await makeApp(pool)
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await pool.end()
})

const buy = (user: TestUser, seats: { sectionId: string; row: number; number: number }[]) =>
  app.inject({
    method: 'POST',
    url: '/orders',
    headers: { authorization: `Bearer ${user.token}`, 'idempotency-key': randomUUID() },
    payload: { eventId: event.id, seats },
  })

/** Verifica contra la base que ningún asiento esté asignado a más de una orden activa. */
async function assertNoOverselling() {
  const { rows } = await pool.query(`
    SELECT oi.seat_id, count(*)::int AS orders
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE o.status IN ('pending_payment', 'paid')
     GROUP BY oi.seat_id
    HAVING count(*) > 1`)
  expect(rows, 'asientos vendidos más de una vez').toEqual([])

  // Y el inventario coincide con las órdenes: cada asiento retenido apunta a una orden que lo incluye.
  const { rows: mismatched } = await pool.query(`
    SELECT s.id FROM seats s
     WHERE s.status = 'held'
       AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.seat_id = s.id AND oi.order_id = s.order_id)`)
  expect(mismatched).toEqual([])
}

describe('concurrencia', () => {
  it('50 personas compran el mismo asiento al mismo tiempo: gana exactamente una', async () => {
    event = await seedEvent(pool, [{ rows: 1, seatsPerRow: 1 }])
    const buyers = await Promise.all(Array.from({ length: 50 }, () => makeUser()))
    const target = [{ sectionId: event.sections[0]!.id, row: 1, number: 1 }]

    const results = await Promise.all(buyers.map((b) => buy(b, target)))
    const statuses = results.map((r) => r.statusCode)

    expect(statuses.filter((s) => s === 201)).toHaveLength(1)
    expect(statuses.filter((s) => s === 409)).toHaveLength(49)
    await assertNoOverselling()
  })

  it('100 compradores, pedidos superpuestos en orden aleatorio: sin sobreventa ni deadlocks', async () => {
    event = await seedEvent(pool, [{ rows: 3, seatsPerRow: 10 }])
    const sectionId = event.sections[0]!.id
    const allSeats = Array.from({ length: 30 }, (_, i) => ({
      sectionId,
      row: Math.floor(i / 10) + 1,
      number: (i % 10) + 1,
    }))
    const buyers = await Promise.all(Array.from({ length: 100 }, () => makeUser()))

    // Cada uno pide 1 a 4 asientos al azar, en orden aleatorio: el escenario clásico de deadlock
    // si los locks no se tomaran siempre en el mismo orden.
    const requests = buyers.map((b) => {
      const shuffled = [...allSeats].sort(() => Math.random() - 0.5)
      return buy(b, shuffled.slice(0, 1 + Math.floor(Math.random() * 4)))
    })
    const results = await Promise.all(requests)
    const statuses = results.map((r) => r.statusCode)

    // Solo resultados de negocio: nada de 500 (un deadlock se vería como error interno).
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true)
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThan(0)
    await assertNoOverselling()

    const sold = results.filter((r) => r.statusCode === 201).flatMap((r) => r.json().items)
    expect(sold.length).toBeLessThanOrEqual(30)
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM seats WHERE status = 'held'`)
    expect(rows[0].n).toBe(sold.length)
  })
})
