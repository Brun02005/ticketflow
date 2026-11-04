import { connect, type Channel, type ChannelModel } from 'amqplib'
import { context, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  EVENTS_EXCHANGE,
  OutboxRelay,
  RabbitConsumer,
  RabbitPublisher,
  enqueueOutbox,
  registerOutboxGauge,
  registry,
  type Pool,
  type Redis,
} from '@ticketflow/common'
import { eventInput, makeApp, makeUser, resetData, setupInfra } from './helpers'

/**
 * Observabilidad: trazas que atraviesan outbox + RabbitMQ, y métricas Prometheus.
 * Se usa un TracerProvider en memoria en lugar de exportar a Jaeger.
 */

const exporter = new InMemorySpanExporter()
const silent = { info() {}, warn() {}, error() {} }
let pool: Pool
let redis: Redis

beforeAll(async () => {
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }))
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  ;({ pool, redis } = await setupInfra())
})

beforeEach(async () => {
  exporter.reset()
  await resetData(pool, redis)
})

afterAll(async () => {
  trace.disable()
  context.disable()
  propagation.disable()
  redis.disconnect()
  await pool.end()
})

describe('trazas distribuidas a través del outbox', () => {
  let conn: ChannelModel
  let channel: Channel
  const queue = `trace.test.${Date.now()}`

  beforeAll(async () => {
    conn = await connect(process.env.TEST_RABBITMQ_URL!)
    channel = await conn.createChannel()
  })

  afterEach(async () => {
    await channel.deleteQueue(queue).catch(() => {})
    await channel.deleteQueue(`${queue}.retry`).catch(() => {})
    await channel.deleteQueue(`${queue}.dlq`).catch(() => {})
  })

  afterAll(async () => {
    await conn.close()
  })

  it('request → outbox → relay → RabbitMQ → consumidor quedan en una sola traza', async () => {
    // 1. Una "request" que genera un evento de dominio.
    const tracer = trace.getTracer('test')
    const rootTraceId = await tracer.startActiveSpan('POST /events/:id/publish', async (span) => {
      await enqueueOutbox(pool, { type: 'trace.check', aggregateId: 'x', payload: {} })
      span.end()
      return span.spanContext().traceId
    })

    // El traceparent quedó guardado junto al mensaje.
    const { rows } = await pool.query(`SELECT headers FROM outbox`)
    expect(rows[0].headers.traceparent).toContain(rootTraceId)

    // 2. Un consumidor real escuchando en RabbitMQ.
    let consumerTraceId: string | undefined
    const consumer = await RabbitConsumer.start(
      process.env.TEST_RABBITMQ_URL!,
      { queue, bindings: ['trace.check'] },
      async () => {
        consumerTraceId = trace.getActiveSpan()?.spanContext().traceId
      },
      silent,
    )
    await consumer.waitUntilReady()

    // 3. El relay publica más tarde, fuera de la request original.
    const publisher = await RabbitPublisher.connect(process.env.TEST_RABBITMQ_URL!, silent)
    await publisher.waitForConnect()
    await new OutboxRelay(pool, publisher, silent).processBatch()

    await expect.poll(() => consumerTraceId).toBe(rootTraceId)
    await consumer.close()
    await publisher.close()

    // 4. La cadena de spans: request → publish → process.
    const spans = exporter.getFinishedSpans()
    const byName = (name: string) => spans.find((s) => s.name === name)!
    const root = byName('POST /events/:id/publish')
    const publish = byName('publish trace.check')
    const process_ = byName('process trace.check')

    expect(new Set([root, publish, process_].map((s) => s.spanContext().traceId))).toEqual(new Set([rootTraceId]))
    expect(publish.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(process_.parentSpanContext?.spanId).toBe(publish.spanContext().spanId)
  })

  it('sin OpenTelemetry activo, el outbox funciona igual (headers vacíos)', async () => {
    propagation.disable()
    await enqueueOutbox(pool, { type: 'x', aggregateId: 'x', payload: {} })
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())

    const { rows } = await pool.query(`SELECT headers FROM outbox`)
    expect(rows[0].headers).toEqual({})
  })
})

describe('métricas Prometheus', () => {
  it('registra la latencia por ruta (con parámetros, no la URL concreta) y el outbox pendiente', async () => {
    const app = await makeApp(pool, redis)
    const organizer = await makeUser('organizer')
    const created = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${organizer.token}` },
      payload: eventInput(),
    })
    await app.inject({
      method: 'POST',
      url: `/events/${created.json().id}/publish`,
      headers: { authorization: `Bearer ${organizer.token}` },
    })
    registerOutboxGauge(pool)

    const metrics = await registry.metrics()
    expect(metrics).toMatch(
      /http_server_request_duration_seconds_count\{service="events-service",method="POST",route="\/events\/:id\/publish",status_code="200"\} \d+/,
    )
    expect(metrics).toMatch(/outbox_pending_messages\{service="events-service"\} 1/)
    expect(metrics).toContain('nodejs_eventloop_lag_seconds')
    await app.close()
  })
})
