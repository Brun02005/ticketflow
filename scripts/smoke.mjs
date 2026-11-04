// Prueba de punta a punta contra el sistema levantado, pasando por el gateway.
// Uso: npm run smoke   (GATEWAY_URL y RABBITMQ_API_URL configurables)
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000'
const RABBIT_API = process.env.RABBITMQ_API_URL ?? 'http://guest:guest@localhost:15672'

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
}

async function step(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
    throw err
  }
}

const register = async (role) => {
  const res = await call('POST', '/auth/register', {
    body: { email: `${role}-${randomUUID().slice(0, 8)}@smoke.test`, password: 'smoke-password', role },
  })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body
}

async function publishedCount() {
  const url = new URL('/api/exchanges/%2F/ticketflow.events', RABBIT_API)
  const auth = Buffer.from(`${url.username}:${url.password}`).toString('base64')
  url.username = url.password = ''
  const res = await fetch(url, { headers: { authorization: `Basic ${auth}` } })
  if (!res.ok) return 0
  return (await res.json()).message_stats?.publish_in ?? 0
}

console.log(`Smoke test contra ${GATEWAY}\n`)
let organizer, customer, event
const publishedBefore = await publishedCount()

await step('registro de organizador y cliente', async () => {
  organizer = await register('organizer')
  customer = await register('customer')
})

await step('el organizador crea un evento (events-service valida el JWT vía JWKS)', async () => {
  const res = await call('POST', '/events', {
    token: organizer.tokens.accessToken,
    body: {
      title: `Smoke ${new Date().toISOString()}`,
      venueName: 'Estadio Smoke',
      city: 'Rosario',
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      sections: [{ name: 'Campo', priceCents: 100_000, rows: 10, seatsPerRow: 10 }],
    },
  })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  event = res.body
})

await step('un cliente no puede crear eventos (403)', async () => {
  const res = await call('POST', '/events', { token: customer.tokens.accessToken, body: {} })
  assert.equal(res.status, 403)
})

await step('publicar el evento', async () => {
  const res = await call('POST', `/events/${event.id}/publish`, { token: organizer.tokens.accessToken })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.status, 'published')
})

await step('el detalle se cachea en Redis (MISS → HIT)', async () => {
  const first = await call('GET', `/events/${event.id}`)
  const second = await call('GET', `/events/${event.id}`)
  assert.equal(first.headers.get('x-cache'), 'MISS')
  assert.equal(second.headers.get('x-cache'), 'HIT')
})

await step('aparece en el listado público', async () => {
  const res = await call('GET', `/events?city=Rosario&limit=100`)
  assert.ok(res.body.items.some((e) => e.id === event.id))
})

await step('el outbox publicó event.published en RabbitMQ', async () => {
  const deadline = Date.now() + 5000
  while ((await publishedCount()) <= publishedBefore) {
    if (Date.now() > deadline) throw new Error('no llegó ningún mensaje al exchange ticketflow.events')
    await new Promise((r) => setTimeout(r, 250))
  }
})

const buy = (user, seats, key = randomUUID()) =>
  fetch(`${GATEWAY}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${user.tokens.accessToken}`,
      'idempotency-key': key,
    },
    body: JSON.stringify({ eventId: event.id, seats }),
  }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }))

const seat = (row, number) => ({ sectionId: event.sections[0].id, row, number })
let order

await step('orders-service arma el inventario a partir del mensaje de RabbitMQ', async () => {
  const deadline = Date.now() + 10_000
  for (;;) {
    const res = await call('GET', `/availability/${event.id}`)
    if (res.status === 200) {
      assert.equal(res.body.sections[0].available, 100)
      return
    }
    if (Date.now() > deadline) throw new Error(`la disponibilidad no apareció (último status ${res.status})`)
    await new Promise((r) => setTimeout(r, 250))
  }
})

await step('un cliente reserva 2 asientos', async () => {
  const res = await buy(customer, [seat(1, 1), seat(1, 2)])
  assert.equal(res.status, 201, JSON.stringify(res.body))
  assert.equal(res.body.status, 'pending_payment')
  assert.equal(res.body.totalCents, 200_000)
  order = res.body
})

await step('reintentar con la misma Idempotency-Key no crea otra orden', async () => {
  const key = randomUUID()
  const first = await buy(customer, [seat(2, 1)], key)
  const retry = await buy(customer, [seat(2, 1)], key)
  assert.equal(retry.body.id, first.body.id)
  assert.equal(retry.headers.get('idempotent-replayed'), 'true')
})

await step('30 compras simultáneas del mismo asiento: gana una sola', async () => {
  // Claves de idempotencia distintas = 30 compras independientes compitiendo por el asiento.
  // (Un mismo usuario alcanza: registrar 30 cuentas chocaría con el rate limit de registro.)
  const results = await Promise.all(Array.from({ length: 30 }, () => buy(organizer, [seat(5, 5)])))
  const won = results.filter((r) => r.status === 201).length
  const lost = results.filter((r) => r.status === 409).length
  assert.equal(won, 1, `ganaron ${won}`)
  assert.equal(lost, 29)
})

await step('cancelar la orden libera los asientos', async () => {
  const res = await call('POST', `/orders/${order.id}/cancel`, { token: customer.tokens.accessToken })
  assert.equal(res.body.status, 'cancelled')
  const map = await call('GET', `/availability/${event.id}/sections/${event.sections[0].id}`)
  assert.equal(map.body.rows[0].seats[0].available, true)
})

const poll = async (fn, expected, what, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last === expected) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`${what}: se esperaba "${expected}", quedó "${last}"`)
}
const payWith = (orderId, cardNumber) =>
  call('POST', `/payments/${orderId}/pay`, { token: customer.tokens.accessToken, body: { cardNumber } })
const paymentStatus = async (orderId) =>
  (await call('GET', `/payments/${orderId}`, { token: customer.tokens.accessToken })).body?.payment?.status
let toPay

await step('nueva orden: payments crea el pago a partir de order.created', async () => {
  const res = await buy(customer, [seat(3, 1), seat(3, 2)])
  assert.equal(res.status, 201, JSON.stringify(res.body))
  toPay = res.body
  await poll(() => paymentStatus(toPay.id), 'awaiting_payment', 'estado del pago')
})

await step('tarjeta rechazada: el webhook firmado informa el rechazo y se puede reintentar', async () => {
  const res = await payWith(toPay.id, '4000000000000002')
  assert.equal(res.status, 202, JSON.stringify(res.body))
  await poll(() => paymentStatus(toPay.id), 'awaiting_payment', 'pago tras el rechazo')
  const { body } = await call('GET', `/payments/${toPay.id}`, { token: customer.tokens.accessToken })
  assert.equal(body.charges[0].failureReason, 'card_declined')
})

await step('tarjeta aprobada: saga completa (pasarela → webhook → payments → RabbitMQ → orders)', async () => {
  const res = await payWith(toPay.id, '4242424242424242')
  assert.equal(res.status, 202, JSON.stringify(res.body))
  await poll(
    async () => (await call('GET', `/orders/${toPay.id}`, { token: customer.tokens.accessToken })).body.status,
    'paid',
    'estado de la orden',
  )
})

await step('los asientos pagados quedan vendidos y no se pueden volver a comprar', async () => {
  const again = await buy(organizer, [seat(3, 1)])
  assert.equal(again.status, 409)
  const twice = await payWith(toPay.id, '4242424242424242')
  assert.equal(twice.body.error.code, 'ALREADY_PAID')
})

const MAILPIT = process.env.MAILPIT_API_URL ?? 'http://localhost:8025'
const inbox = async (to) => {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`).then((r) => r.json())
  return res.messages ?? []
}

await step('llegan los emails: bienvenida, pago rechazado y entradas con QR (Mailpit)', async () => {
  const email = customer.user.email
  const deadline = Date.now() + 20_000
  let subjects = []
  while (Date.now() < deadline) {
    subjects = (await inbox(email)).map((m) => m.Subject)
    if (subjects.some((s) => s.startsWith('Tus entradas'))) break
    await new Promise((r) => setTimeout(r, 500))
  }
  assert.ok(subjects.includes('Bienvenido a TicketFlow'), `asuntos recibidos: ${subjects.join(' | ')}`)
  assert.ok(subjects.some((s) => s.startsWith('No pudimos procesar tu pago')), `asuntos: ${subjects.join(' | ')}`)
  const tickets = (await inbox(email)).find((m) => m.Subject.startsWith('Tus entradas'))
  assert.ok(tickets, `no llegó el email de entradas (asuntos: ${subjects.join(' | ')})`)
  const full = await fetch(`${MAILPIT}/api/v1/message/${tickets.ID}`).then((r) => r.json())
  assert.equal(full.Inline.length, 2, 'un QR por asiento')
})

await step('el QR de la entrada se valida en la puerta (y uno adulterado no)', async () => {
  const tickets = (await inbox(customer.user.email)).find((m) => m.Subject.startsWith('Tus entradas'))
  const full = await fetch(`${MAILPIT}/api/v1/message/${tickets.ID}`).then((r) => r.json())
  const code = full.Text.match(/TF1\.[\w-]+\.[\w-]+/)[0]
  const valid = await call('POST', '/tickets/verify', { token: organizer.tokens.accessToken, body: { code } })
  assert.equal(valid.body.valid, true, JSON.stringify(valid.body))
  const forged = await call('POST', '/tickets/verify', {
    token: organizer.tokens.accessToken,
    body: { code: code.slice(0, -2) + (code.endsWith('AA') ? 'BB' : 'AA') },
  })
  assert.equal(forged.body.valid, false)
})

await step('el refresh token rota y el viejo queda inválido', async () => {
  const refreshed = await call('POST', '/auth/refresh', { body: { refreshToken: organizer.tokens.refreshToken } })
  assert.equal(refreshed.status, 200)
  const reused = await call('POST', '/auth/refresh', { body: { refreshToken: organizer.tokens.refreshToken } })
  assert.equal(reused.status, 401)
})

console.log('\nTodo OK')
