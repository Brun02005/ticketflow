import { randomUUID } from 'node:crypto'
import { PoisonMessageError, type Pool } from '@ticketflow/common'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleDomainEvent } from '../src/projection'
import { domainEvent, makeApp, makeUser, resetData, seedEvent, setupDb, silentLogger } from './helpers'

let pool: Pool

beforeAll(async () => {
  pool = await setupDb()
})

beforeEach(async () => {
  await resetData(pool)
})

afterAll(async () => {
  await pool.end()
})

const count = async (table: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n

const publishedPayload = (id = randomUUID()) => ({
  id,
  title: 'Recital',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  currency: 'ARS',
  sections: [{ id: randomUUID(), name: 'Campo', priceCents: 100, rows: 4, seatsPerRow: 25 }],
  // Campos que orders no usa: el lector tolerante los ignora.
  organizerId: randomUUID(),
  venueName: 'Estadio',
})

describe('event.published', () => {
  it('genera el inventario completo de asientos', async () => {
    await handleDomainEvent(pool, domainEvent('event.published', publishedPayload()), silentLogger)
    expect(await count('seats')).toBe(100)
  })

  it('un mensaje entregado dos veces se procesa una sola vez', async () => {
    const message = domainEvent('event.published', publishedPayload())
    await handleDomainEvent(pool, message, silentLogger)
    await handleDomainEvent(pool, message, silentLogger)

    expect(await count('seats')).toBe(100)
    expect(await count('processed_messages')).toBe(1)
  })

  it('un payload que no cumple el contrato es un mensaje venenoso (va a la DLQ)', async () => {
    const broken = domainEvent('event.published', { id: 'x', sections: 'no-es-un-array' })
    await expect(handleDomainEvent(pool, broken, silentLogger)).rejects.toBeInstanceOf(PoisonMessageError)
    expect(await count('processed_messages')).toBe(0)
  })

  it('ignora tipos de mensaje que no le interesan', async () => {
    await handleDomainEvent(pool, domainEvent('user.registered', {}), silentLogger)
    expect(await count('processed_messages')).toBe(0)
  })
})

describe('event.cancelled', () => {
  it('cancela las órdenes pendientes, libera asientos y emite order.cancelled', async () => {
    const event = await seedEvent(pool, [{ rows: 1, seatsPerRow: 5 }])
    const app = await makeApp(pool)
    const user = await makeUser()
    await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${user.token}`, 'idempotency-key': randomUUID() },
      payload: { eventId: event.id, seats: [{ sectionId: event.sections[0]!.id, row: 1, number: 1 }] },
    })
    await app.close()

    await handleDomainEvent(pool, domainEvent('event.cancelled', { eventId: event.id }), silentLogger)

    expect((await pool.query(`SELECT status FROM orders`)).rows[0].status).toBe('cancelled')
    expect((await pool.query(`SELECT count(*)::int AS n FROM seats WHERE status <> 'available'`)).rows[0].n).toBe(0)
    expect((await pool.query(`SELECT type FROM outbox ORDER BY id`)).rows.map((r) => r.type)).toEqual([
      'order.created',
      'order.cancelled',
    ])
  })

  it('si la cancelación llega antes que la publicación, el evento nunca se pone a la venta', async () => {
    const payload = publishedPayload()
    await handleDomainEvent(pool, domainEvent('event.cancelled', { eventId: payload.id }), silentLogger)
    await handleDomainEvent(pool, domainEvent('event.published', payload), silentLogger)

    expect((await pool.query(`SELECT status FROM events WHERE id = $1`, [payload.id])).rows[0].status).toBe('cancelled')
    expect(await count('seats')).toBe(0)
  })
})
