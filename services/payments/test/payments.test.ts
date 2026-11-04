import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from '@ticketflow/common'
import { PspClient } from '../src/psp-client'
import { dispatchRefunds, reconcileCharges } from '../src/reconciler'
import { handleOrderMessage } from '../src/saga'
import { buildApp } from '../src/app'
import {
  CARDS,
  WEBHOOK_SECRET,
  makeUser,
  message,
  orderCreated,
  resetData,
  silentLogger,
  startStack,
  verifyToken,
} from './helpers'

let stack: Awaited<ReturnType<typeof startStack>>
let user: Awaited<ReturnType<typeof makeUser>>

beforeAll(async () => {
  stack = await startStack()
  user = await makeUser()
})

beforeEach(async () => {
  await resetData(stack.pool)
})

afterAll(async () => {
  await stack.close()
})

const pay = (orderId: string, cardNumber: string, token = user.token) =>
  stack.app.inject({
    method: 'POST',
    url: `/payments/${orderId}/pay`,
    headers: { authorization: `Bearer ${token}` },
    payload: { cardNumber },
  })

const status = async (orderId: string) =>
  (await stack.pool.query(`SELECT status FROM payments WHERE order_id = $1`, [orderId])).rows[0]?.status
const outboxTypes = async () => (await stack.pool.query(`SELECT type FROM outbox ORDER BY id`)).rows.map((r) => r.type)

describe('crear el pago', () => {
  it('order.created crea el pago con el monto de la orden; solo el dueño lo ve', async () => {
    const order = await orderCreated(stack.pool, user.id)
    const other = await makeUser()
    const get = (token: string) =>
      stack.app.inject({ method: 'GET', url: `/payments/${order.id}`, headers: { authorization: `Bearer ${token}` } })

    expect((await get(user.token)).json().payment).toMatchObject({ status: 'awaiting_payment', amountCents: 15_000 })
    expect((await get(other.token)).statusCode).toBe(404)
  })
})

describe('cobrar', () => {
  it('tarjeta aprobada: el webhook firmado confirma el pago y se emite payment.succeeded', async () => {
    const order = await orderCreated(stack.pool, user.id)
    const res = await pay(order.id, CARDS.ok)

    expect(res.statusCode).toBe(202)
    expect(res.json().payment.status).toBe('processing')
    await expect.poll(() => status(order.id)).toBe('succeeded')
    expect(await outboxTypes()).toEqual(['payment.succeeded'])
  })

  it('tarjeta rechazada: el cliente puede reintentar con otra', async () => {
    const order = await orderCreated(stack.pool, user.id)
    await pay(order.id, CARDS.declined)
    await expect.poll(() => status(order.id)).toBe('awaiting_payment')

    await pay(order.id, CARDS.ok)
    await expect.poll(() => status(order.id)).toBe('succeeded')

    const { charges } = (
      await stack.app.inject({ method: 'GET', url: `/payments/${order.id}`, headers: { authorization: `Bearer ${user.token}` } })
    ).json()
    expect(charges.map((c: { status: string; failureReason: string | null }) => [c.status, c.failureReason])).toEqual([
      ['failed', 'card_declined'],
      ['succeeded', null],
    ])
    expect(await outboxTypes()).toEqual(['payment.failed', 'payment.succeeded'])
  })

  it('doble click: dos pagos simultáneos de la misma orden, uno solo llega a la pasarela', async () => {
    const order = await orderCreated(stack.pool, user.id)
    const chargesBefore = stack.psp.provider.listCharges().length
    const results = await Promise.all([pay(order.id, CARDS.ok), pay(order.id, CARDS.ok)])

    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409])
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe('PAYMENT_IN_PROGRESS')
    await expect.poll(() => status(order.id)).toBe('succeeded')
    expect(stack.psp.provider.listCharges().length - chargesBefore).toBe(1)
  })

  it('no permite pagar dos veces, ni órdenes vencidas o anuladas', async () => {
    const paid = await orderCreated(stack.pool, user.id)
    await pay(paid.id, CARDS.ok)
    await expect.poll(() => status(paid.id)).toBe('succeeded')
    expect((await pay(paid.id, CARDS.ok)).json().error.code).toBe('ALREADY_PAID')

    const expired = await orderCreated(stack.pool, user.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect((await pay(expired.id, CARDS.ok)).json().error.code).toBe('ORDER_EXPIRED')

    const voided = await orderCreated(stack.pool, user.id)
    await handleOrderMessage(stack.pool, message('order.expired', { orderId: voided.id }), silentLogger)
    expect(await status(voided.id)).toBe('voided')
    expect((await pay(voided.id, CARDS.ok)).json().error.code).toBe('ORDER_NOT_PAYABLE')
  })
})

describe('webhooks', () => {
  const sendWebhook = (body: string, signature?: string) =>
    stack.app.inject({
      method: 'POST',
      url: '/webhooks/psp',
      headers: { 'content-type': 'application/json', ...(signature ? { [WEBHOOK_SIGNATURE_HEADER]: signature } : {}) },
      payload: body,
    })

  it('un webhook duplicado se procesa una sola vez', async () => {
    const order = await orderCreated(stack.pool, user.id)
    const delivered = () => stack.psp.provider.deliveries.filter((d) => d.delivered).length
    const before = delivered()
    await pay(order.id, CARDS.duplicateWebhook)

    await expect.poll(() => delivered() - before).toBe(2)
    expect((await stack.pool.query(`SELECT count(*)::int AS n FROM webhook_events`)).rows[0].n).toBe(1)
    expect(await outboxTypes()).toEqual(['payment.succeeded'])
  })

  it('rechaza webhooks sin firma, con firma inválida, adulterados o viejos (replay)', async () => {
    const body = JSON.stringify({ id: 'evt_x', type: 'charge.succeeded', data: {} })
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600

    expect((await sendWebhook(body)).json().error.code).toBe('MISSING_SIGNATURE')
    expect((await sendWebhook(body, signWebhook('otro-secreto', body))).json().error.code).toBe('INVALID_SIGNATURE')
    expect((await sendWebhook(body.replace('evt_x', 'evt_y'), signWebhook(WEBHOOK_SECRET, body))).json().error.code).toBe(
      'INVALID_SIGNATURE',
    )
    expect((await sendWebhook(body, signWebhook(WEBHOOK_SECRET, body, oneHourAgo))).json().error.code).toBe(
      'STALE_SIGNATURE',
    )
  })

  it('si el monto cobrado no coincide con la orden, no confirma el pago y lo reembolsa', async () => {
    const order = await orderCreated(stack.pool, user.id)
    await pay(order.id, CARDS.lostWebhook) // la pasarela no va a mandar su propio webhook
    const { rows } = await stack.pool.query(`SELECT id FROM charges`)

    const forged = JSON.stringify({
      id: 'evt_monto',
      type: 'charge.succeeded',
      data: { id: 'ch_x', reference: rows[0].id, amount: 1, currency: 'ARS', status: 'succeeded', failureReason: null },
    })
    expect((await sendWebhook(forged, signWebhook(WEBHOOK_SECRET, forged))).statusCode).toBe(200)

    expect(await status(order.id)).toBe('refund_pending')
    expect(await outboxTypes()).toEqual([])
  })
})

describe('conciliación', () => {
  it('si el webhook se pierde, la conciliación consulta a la pasarela y confirma el pago', async () => {
    const order = await orderCreated(stack.pool, user.id)
    await pay(order.id, CARDS.lostWebhook)
    await new Promise((r) => setTimeout(r, 100))
    expect(await status(order.id)).toBe('processing')

    expect(await reconcileCharges(stack.pool, stack.pspClient, 0, silentLogger)).toBe(1)
    expect(await status(order.id)).toBe('succeeded')
    expect(await outboxTypes()).toEqual(['payment.succeeded'])
  })

  it('si la pasarela no respondió, el cobro queda en duda y la conciliación lo resuelve', async () => {
    const order = await orderCreated(stack.pool, user.id)
    const offline = await buildApp(stack.config, {
      pool: stack.pool,
      verifyToken,
      psp: new PspClient({ baseUrl: 'http://127.0.0.1:9', apiKey: 'x', retries: 0, timeoutMs: 500 }),
    })

    const res = await offline.inject({
      method: 'POST',
      url: `/payments/${order.id}/pay`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { cardNumber: CARDS.ok },
    })
    await offline.close()
    // No sabemos si se cobró: no se marca como fallido a ciegas.
    expect(res.json().payment.status).toBe('processing')

    await reconcileCharges(stack.pool, stack.pspClient, 0, silentLogger)
    expect(await status(order.id)).toBe('awaiting_payment') // la pasarela nunca lo recibió
  })
})

describe('compensación: reembolsos', () => {
  it('order.payment_rejected → reembolso en la pasarela → payment.refunded', async () => {
    const order = await orderCreated(stack.pool, user.id)
    await pay(order.id, CARDS.ok)
    await expect.poll(() => status(order.id)).toBe('succeeded')

    await handleOrderMessage(stack.pool, message('order.payment_rejected', { orderId: order.id }), silentLogger)
    expect(await status(order.id)).toBe('refund_pending')

    expect(await dispatchRefunds(stack.pool, stack.pspClient, stack.config.PUBLIC_WEBHOOK_URL, 60, silentLogger)).toBe(1)
    // Reclamado: otra corrida inmediata no lo vuelve a pedir.
    expect(await dispatchRefunds(stack.pool, stack.pspClient, stack.config.PUBLIC_WEBHOOK_URL, 60, silentLogger)).toBe(0)

    await expect.poll(() => status(order.id)).toBe('refunded')
    expect(await outboxTypes()).toEqual(['payment.succeeded', 'payment.refunded'])
  })

  it('evento cancelado: una orden sin pagar se anula, una pagada se reembolsa', async () => {
    const unpaid = await orderCreated(stack.pool, user.id)
    const paid = await orderCreated(stack.pool, user.id)
    await pay(paid.id, CARDS.ok)
    await expect.poll(() => status(paid.id)).toBe('succeeded')

    for (const order of [unpaid, paid]) {
      await handleOrderMessage(stack.pool, message('order.cancelled', { orderId: order.id }), silentLogger)
    }

    expect(await status(unpaid.id)).toBe('voided')
    expect(await status(paid.id)).toBe('refund_pending')
  })
})
