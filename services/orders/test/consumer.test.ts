import { randomUUID } from 'node:crypto'
import { type DomainEvent, EVENTS_EXCHANGE, type Pool, RabbitConsumer } from '@ticketflow/common'
import { type Channel, type ChannelModel, connect } from 'amqplib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleDomainEvent } from '../src/projection'
import { domainEvent, resetData, setupDb, silentLogger } from './helpers'

/** Tests contra un RabbitMQ real: topología, reintentos, DLQ y duplicados. */

const URL = process.env.TEST_RABBITMQ_URL!
let pool: Pool
let conn: ChannelModel
let channel: Channel
let queue: string
let consumer: RabbitConsumer | undefined

beforeAll(async () => {
  pool = await setupDb()
  conn = await connect(URL)
  channel = await conn.createChannel()
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
})

beforeEach(async () => {
  await resetData(pool)
  // Cola única por test: no se mezcla con el servicio real ni con otros tests.
  queue = `orders.test.${randomUUID().slice(0, 8)}`
})

afterEach(async () => {
  await consumer?.close()
  consumer = undefined
  await channel.deleteQueue(queue).catch(() => {})
  await channel.deleteQueue(`${queue}.dlq`).catch(() => {})
  await channel.deleteQueue(`${queue}.retry`).catch(() => {})
})

afterAll(async () => {
  await conn.close()
  await pool.end()
})

const publish = (routingKey: string, body: unknown) =>
  channel.publish(EVENTS_EXCHANGE, routingKey, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))

const dlqDepth = async () => (await channel.checkQueue(`${queue}.dlq`)).messageCount

async function startConsumer(handler: (event: DomainEvent) => Promise<void>, options: { maxRetries?: number } = {}) {
  consumer = await RabbitConsumer.start(
    URL,
    { queue, bindings: ['event.*'], retryDelayMs: 10, ...options },
    handler,
    silentLogger,
  )
  await consumer.waitUntilReady()
}

describe('consumidor de eventos', () => {
  it('construye el inventario a partir de event.published', async () => {
    await startConsumer((e) => handleDomainEvent(pool, e, silentLogger))
    publish(
      'event.published',
      domainEvent('event.published', {
        id: randomUUID(),
        title: 'Desde RabbitMQ',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        currency: 'ARS',
        sections: [{ id: randomUUID(), name: 'Campo', priceCents: 100, rows: 2, seatsPerRow: 10 }],
      }),
    )

    await expect.poll(async () => (await pool.query(`SELECT count(*)::int AS n FROM seats`)).rows[0].n).toBe(20)
  })

  it('el mismo mensaje entregado varias veces tiene efecto una sola vez', async () => {
    await startConsumer((e) => handleDomainEvent(pool, e, silentLogger))
    const message = domainEvent('event.published', {
      id: randomUUID(),
      title: 'Duplicado',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      currency: 'ARS',
      sections: [{ id: randomUUID(), name: 'Campo', priceCents: 100, rows: 1, seatsPerRow: 10 }],
    })
    for (let i = 0; i < 3; i++) publish('event.published', message)

    await expect.poll(async () => (await channel.checkQueue(queue)).messageCount).toBe(0)
    await new Promise((r) => setTimeout(r, 200))
    expect((await pool.query(`SELECT count(*)::int AS n FROM seats`)).rows[0].n).toBe(10)
  })

  it('un mensaje ilegible va directo a la dead-letter queue', async () => {
    let calls = 0
    await startConsumer(async () => {
      calls++
    })
    publish('event.published', '{esto no es json')

    await expect.poll(dlqDepth).toBe(1)
    expect(calls).toBe(0)
  })

  it('un error transitorio se reintenta y, si persiste, termina en la DLQ', { timeout: 15_000 }, async () => {
    let attempts = 0
    await startConsumer(
      async () => {
        attempts++
        throw new Error('base de datos caída')
      },
      { maxRetries: 3 },
    )
    publish('event.published', domainEvent('event.published', {}))

    await expect.poll(dlqDepth, { timeout: 8000 }).toBe(1)
    // 1 intento original + 3 reintentos.
    expect(attempts).toBe(4)
  })

  it('un error transitorio que se resuelve no pierde el mensaje', { timeout: 15_000 }, async () => {
    let attempts = 0
    await startConsumer(async () => {
      attempts++
      if (attempts < 3) throw new Error('falla momentánea')
    })
    publish('event.published', domainEvent('event.published', {}))

    await expect.poll(() => attempts, { timeout: 8000 }).toBe(3)
    await expect.poll(async () => (await channel.checkQueue(queue)).messageCount).toBe(0)
    expect(await dlqDepth()).toBe(0)
  })
})
