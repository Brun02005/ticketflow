import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from '@ticketflow/common'
import { buildApp, loadConfig } from '../src/app'

const SECRET = 'whsec_test_secret'
const API_KEY = 'sk_test_key_123'

interface Received {
  event: { id: string; type: string; data: Record<string, unknown> }
  validSignature: boolean
}

let receiver: FastifyInstance
let webhookUrl: string
let received: Received[]
/** Cuántas veces seguidas el receptor responde 500 antes de aceptar. */
let failNext = 0
let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => {
  receiver = Fastify()
  receiver.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))
  receiver.post('/webhook', async (req, reply) => {
    if (failNext > 0) {
      failNext--
      return reply.status(500).send()
    }
    const raw = req.body as string
    const header = req.headers[WEBHOOK_SIGNATURE_HEADER] as string
    received.push({ event: JSON.parse(raw), validSignature: verifyWebhookSignature(SECRET, header, raw).ok })
    return { ok: true }
  })
  await receiver.listen({ port: 0, host: '127.0.0.1' })
  webhookUrl = `http://127.0.0.1:${(receiver.server.address() as { port: number }).port}/webhook`
})

beforeEach(async () => {
  received = []
  failNext = 0
  app = await buildApp(
    loadConfig({
      LOG_LEVEL: 'silent',
      PSP_API_KEY: API_KEY,
      PSP_WEBHOOK_SECRET: SECRET,
      PSP_MIN_DELAY_MS: '5',
      PSP_MAX_DELAY_MS: '20',
      PSP_WEBHOOK_RETRY_BASE_MS: '10',
    }),
  )
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await receiver.close()
})

const charge = (cardNumber: string, key = randomUUID(), reference = randomUUID()) =>
  app.inject({
    method: 'POST',
    url: '/v1/charges',
    headers: { authorization: `Bearer ${API_KEY}`, 'idempotency-key': key },
    payload: { amount: 5000, currency: 'ARS', reference, cardNumber, webhookUrl },
  })

const getCharge = (id: string) =>
  app.inject({ method: 'GET', url: `/v1/charges/${id}`, headers: { authorization: `Bearer ${API_KEY}` } })

describe('API de la pasarela', () => {
  it('exige API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/charges' })
    expect(res.statusCode).toBe(401)
  })

  it('el cobro es asincrónico y nunca expone el número de tarjeta', async () => {
    const res = await charge('4242424242424242')
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ status: 'processing', cardLast4: '4242' })
    expect(JSON.stringify(res.json())).not.toContain('4242424242424242')
  })

  it('es idempotente: misma clave devuelve el mismo cobro; con otro body, 422', async () => {
    const key = randomUUID()
    const reference = randomUUID()
    const first = await charge('4242424242424242', key, reference)
    const retry = await charge('4242424242424242', key, reference)
    expect(retry.json().id).toBe(first.json().id)

    const reused = await charge('4000000000000002', key, reference)
    expect(reused.statusCode).toBe(422)
  })
})

describe('webhooks', () => {
  it('avisa la aprobación con un webhook firmado', async () => {
    const { id } = (await charge('4242424242424242')).json()

    await expect.poll(() => received.length).toBe(1)
    expect(received[0]).toMatchObject({ validSignature: true, event: { type: 'charge.succeeded', data: { id } } })
    expect((await getCharge(id)).json().status).toBe('succeeded')
  })

  it('avisa el rechazo con el motivo', async () => {
    await charge('4000000000009995')
    await expect.poll(() => received.length).toBe(1)
    expect(received[0]!.event).toMatchObject({ type: 'charge.failed', data: { failureReason: 'insufficient_funds' } })
  })

  it('reintenta la entrega con backoff hasta que el receptor responde 2xx', async () => {
    failNext = 2
    await charge('4242424242424242')

    await expect.poll(() => received.length).toBe(1)
    expect(app.provider.deliveries[0]).toMatchObject({ attempts: 3, delivered: true })
  })

  it('[simulación] tarjeta 0077: el mismo webhook llega dos veces', async () => {
    await charge('4000000000000077')
    await expect.poll(() => received.length).toBe(2)
    expect(received[0]!.event.id).toBe(received[1]!.event.id)
  })

  it('[simulación] tarjeta 0101: el webhook se pierde, pero el cobro se puede consultar', async () => {
    const reference = randomUUID()
    await charge('4000000000000101', undefined, reference)
    await new Promise((r) => setTimeout(r, 100))

    expect(received).toHaveLength(0)
    const found = await app.inject({
      method: 'GET',
      url: `/v1/charges?reference=${reference}`,
      headers: { authorization: `Bearer ${API_KEY}` },
    })
    expect(found.json().data[0].status).toBe('succeeded')
  })
})

describe('reembolsos', () => {
  const refund = (chargeId: string, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { authorization: `Bearer ${API_KEY}`, 'idempotency-key': key },
      payload: { charge: chargeId, webhookUrl },
    })

  it('reembolsa un cobro aprobado una sola vez', async () => {
    const { id } = (await charge('4242424242424242')).json()
    await expect.poll(async () => (await getCharge(id)).json().status).toBe('succeeded')

    const key = randomUUID()
    expect((await refund(id, key)).statusCode).toBe(202)
    expect((await refund(id, key)).statusCode).toBe(202) // mismo pedido reintentado
    expect((await refund(id)).json().error.code).toBe('CHARGE_ALREADY_REFUNDED')

    await expect.poll(() => received.map((r) => r.event.type)).toContain('refund.succeeded')
  })

  it('no reembolsa un cobro rechazado', async () => {
    const { id } = (await charge('4000000000000002')).json()
    await expect.poll(async () => (await getCharge(id)).json().status).toBe('failed')
    expect((await refund(id)).json().error.code).toBe('CHARGE_NOT_REFUNDABLE')
  })
})
