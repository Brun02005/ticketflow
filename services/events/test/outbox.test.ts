import {
  type DomainEvent,
  EVENTS_EXCHANGE,
  enqueueOutbox,
  type MessagePublisher,
  OutboxRelay,
  type Pool,
  RabbitPublisher,
  type Redis,
} from '@ticketflow/common'
import { type Channel, type ChannelModel, type ConsumeMessage, connect } from 'amqplib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetData, setupInfra } from './helpers'

const silent = { info() {}, warn() {}, error() {} }

let pool: Pool
let redis: Redis

beforeAll(async () => {
  ;({ pool, redis } = await setupInfra())
})

beforeEach(async () => {
  await resetData(pool, redis)
})

afterAll(async () => {
  redis.disconnect()
  await pool.end()
})

const enqueue = (n: number) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      enqueueOutbox(pool, { type: 'event.published', aggregateId: `agg-${i}`, payload: { n: i } }),
    ),
  )

const pending = async () =>
  (await pool.query(`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`)).rows[0].n

describe('relay contra RabbitMQ real', () => {
  let publisher: RabbitPublisher
  let conn: ChannelModel
  let channel: Channel
  let received: ConsumeMessage[]

  beforeEach(async () => {
    publisher = await RabbitPublisher.connect(process.env.TEST_RABBITMQ_URL!, silent)
    await publisher.waitForConnect()

    // Un consumidor de prueba con una cola temporal enlazada al exchange.
    conn = await connect(process.env.TEST_RABBITMQ_URL!)
    channel = await conn.createChannel()
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
    const { queue } = await channel.assertQueue('', { exclusive: true })
    await channel.bindQueue(queue, EVENTS_EXCHANGE, 'event.#')
    received = []
    await channel.consume(queue, (msg) => msg && received.push(msg), { noAck: true })
  })

  afterEach(async () => {
    await conn.close()
    await publisher.close()
  })

  it('publica los mensajes pendientes en orden y los marca como enviados', async () => {
    for (let i = 0; i < 3; i++) {
      await enqueueOutbox(pool, { type: 'event.published', aggregateId: `agg-${i}`, payload: { n: i } })
    }
    const relay = new OutboxRelay(pool, publisher, silent)

    expect(await relay.processBatch()).toBe(3)
    expect(await pending()).toBe(0)

    await expect.poll(() => received.length).toBe(3)
    const bodies = received.map((m) => JSON.parse(m.content.toString()) as DomainEvent<{ n: number }>)
    expect(bodies.map((b) => b.payload.n)).toEqual([0, 1, 2])

    const { rows } = await pool.query(`SELECT message_id FROM outbox ORDER BY id`)
    expect(received.map((m) => m.properties.messageId)).toEqual(rows.map((r) => r.message_id))
  })
})

describe('relay ante fallos', () => {
  it('si el broker falla, registra el error y corta el lote para no desordenar', async () => {
    await enqueue(3)
    const broken: MessagePublisher = {
      publish: async () => {
        throw new Error('broker caído')
      },
    }

    const published = await new OutboxRelay(pool, broken, silent).processBatch()

    expect(published).toBe(0)
    const { rows } = await pool.query(`SELECT attempts, last_error FROM outbox ORDER BY id`)
    expect(rows).toEqual([
      { attempts: 1, last_error: 'broker caído' },
      { attempts: 0, last_error: null },
      { attempts: 0, last_error: null },
    ])
  })

  it('varias réplicas del relay no publican el mismo mensaje dos veces (SKIP LOCKED)', async () => {
    await enqueue(20)
    const seen: string[] = []
    const slow: MessagePublisher = {
      publish: async (event) => {
        await new Promise((r) => setTimeout(r, 5))
        seen.push(event.messageId)
      },
    }
    const relays = Array.from({ length: 4 }, () => new OutboxRelay(pool, slow, silent, { batchSize: 5 }))

    // Cada réplica procesa lotes hasta que no queda nada pendiente.
    await Promise.all(
      relays.map(async (relay) => {
        while ((await relay.processBatch()) > 0) {}
      }),
    )

    expect(seen).toHaveLength(20)
    expect(new Set(seen).size).toBe(20)
    expect(await pending()).toBe(0)
  })
})
