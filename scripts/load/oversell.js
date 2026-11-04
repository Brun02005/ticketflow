// Prueba de carga: muchos compradores peleando por pocos asientos.
//
// Objetivo: demostrar que bajo concurrencia real no hay sobreventa, no hay
// errores 5xx y la latencia se mantiene acotada.
//
// Uso (corre k6 dentro de Docker, no hace falta instalarlo): npm run load
// Variables: BASE_URL, BUYERS (usuarios distintos), SEATS (filas x 10), PEAK_VUS, DURATION
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'
const BUYERS = Number(__ENV.BUYERS || 40)
const ROWS = Number(__ENV.ROWS || 10)
const SEATS_PER_ROW = 10
const PEAK_VUS = Number(__ENV.PEAK_VUS || 200)
const DURATION = __ENV.DURATION || '30s'

const reservations = new Counter('reservas_creadas')
const seatTaken = new Counter('asiento_ya_tomado')
const payments = new Counter('pagos_iniciados')
const serverErrors = new Counter('errores_5xx')
const oversold = new Counter('asientos_sobrevendidos')
const conflictRate = new Rate('tasa_de_conflicto')
const orderLatency = new Trend('latencia_compra', true)

export const options = {
  scenarios: {
    compradores: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: PEAK_VUS },
        { duration: DURATION, target: PEAK_VUS },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    asientos_sobrevendidos: ['count==0'], // el objetivo central
    errores_5xx: ['count==0'],
    latencia_compra: ['p(95)<1000'],
    checks: ['rate>0.99'],
  },
}

const json = (body, token, extra = {}) => ({
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  },
  // 409 (asiento tomado) y 429 son respuestas esperadas, no fallas de la prueba.
  responseCallback: http.expectedStatuses(200, 201, 202, 409, 429),
})

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function register(role) {
  const email = `${role}-${uuid().slice(0, 12)}@load.test`
  const res = http.post(`${BASE_URL}/auth/register`, JSON.stringify({ email, password: 'load-test-123', role }), json())
  if (res.status !== 201) throw new Error(`registro falló (${res.status}): ${res.body}`)
  return res.json().tokens.accessToken
}

export function setup() {
  const organizer = register('organizer')
  const event = http.post(
    `${BASE_URL}/events`,
    JSON.stringify({
      title: `Prueba de carga ${new Date().toISOString()}`,
      venueName: 'Estadio k6',
      city: 'Rosario',
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      sections: [{ name: 'Campo', priceCents: 100_000, rows: ROWS, seatsPerRow: SEATS_PER_ROW }],
    }),
    json(null, organizer),
  ).json()
  // Sin body no va content-type: Fastify rechaza "application/json" con body vacío.
  const published = http.post(`${BASE_URL}/events/${event.id}/publish`, null, {
    headers: { authorization: `Bearer ${organizer}` },
  })
  if (published.status !== 200) throw new Error(`no se pudo publicar el evento (${published.status}): ${published.body}`)

  // orders arma el inventario de forma asincrónica (RabbitMQ): esperamos que esté listo.
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    ready = http.get(`${BASE_URL}/availability/${event.id}`).status === 200
    if (!ready) sleep(0.5)
  }
  // Si el setup no quedó bien, la prueba no tiene sentido: mejor fallar fuerte.
  if (!ready) throw new Error('orders-service no armó el inventario del evento a tiempo')

  const tokens = Array.from({ length: BUYERS }, () => register('customer'))
  console.log(`Evento ${event.id}: ${ROWS * SEATS_PER_ROW} asientos, ${BUYERS} compradores, hasta ${PEAK_VUS} VUs`)
  return { eventId: event.id, sectionId: event.sections[0].id, tokens }
}

export default function (data) {
  const token = data.tokens[(__VU + __ITER) % data.tokens.length]
  // Cada intento pide 1 a 3 asientos al azar: muchísima superposición entre compradores.
  const wanted = new Set()
  const count = 1 + Math.floor(Math.random() * 3)
  while (wanted.size < count) {
    wanted.add(`${1 + Math.floor(Math.random() * ROWS)}:${1 + Math.floor(Math.random() * SEATS_PER_ROW)}`)
  }
  const seats = [...wanted].map((s) => {
    const [row, number] = s.split(':').map(Number)
    return { sectionId: data.sectionId, row, number }
  })

  const res = http.post(
    `${BASE_URL}/orders`,
    JSON.stringify({ eventId: data.eventId, seats }),
    json(null, token, { 'idempotency-key': uuid() }),
  )
  orderLatency.add(res.timings.duration)
  if (res.status >= 500) serverErrors.add(1)
  const ok = check(res, { 'compra: 201, 409 o 429': (r) => [201, 409, 429].includes(r.status) })
  if (!ok && Math.random() < 0.01) console.warn(`respuesta inesperada en /orders: ${res.status} ${res.body}`)
  conflictRate.add(res.status === 409)

  if (res.status === 201) {
    reservations.add(1)
    // La mitad de las reservas se paga: ejercita la saga completa bajo carga.
    if (Math.random() < 0.5) {
      const orderId = res.json().id
      for (let i = 0; i < 10; i++) {
        const pay = http.post(`${BASE_URL}/payments/${orderId}/pay`, JSON.stringify({ cardNumber: '4242424242424242' }), {
          ...json(null, token),
          // 404 = payments todavía no procesó order.created (asincrónico): se reintenta.
          responseCallback: http.expectedStatuses(202, 404, 409, 429),
        })
        if (pay.status !== 404) {
          if (pay.status === 202) payments.add(1)
          if (pay.status >= 500) serverErrors.add(1)
          break
        }
        sleep(0.2) // payments todavía no recibió order.created
      }
    }
  } else if (res.status === 409) {
    seatTaken.add(1)
  } else if (res.status >= 500) {
    console.error(`5xx en /orders: ${res.status} ${res.body}`)
  }
  sleep(0.05 + Math.random() * 0.2)
}

/**
 * Verificación final contra el sistema: cada asiento puede estar en a lo sumo
 * una orden activa (pendiente o pagada), y el inventario tiene que coincidir.
 */
export function teardown(data) {
  sleep(3) // dejamos que terminen las sagas en curso
  const owner = new Map()
  let duplicated = 0
  let active = 0
  for (const token of data.tokens) {
    const orders = http.get(`${BASE_URL}/orders`, json(null, token)).json().items
    for (const order of orders.filter((o) => o.eventId === data.eventId)) {
      if (order.status !== 'pending_payment' && order.status !== 'paid') continue
      for (const item of order.items) {
        active++
        const key = `${item.row}-${item.number}`
        if (owner.has(key)) duplicated++
        else owner.set(key, order.id)
      }
    }
  }
  const availability = http.get(`${BASE_URL}/availability/${data.eventId}`).json().sections[0]
  const taken = availability.total - availability.available

  console.log(`Asientos: ${availability.total} | tomados según inventario: ${taken} | en órdenes activas: ${active} | duplicados: ${duplicated}`)
  oversold.add(duplicated)
  check(null, {
    'ningún asiento en dos órdenes': () => duplicated === 0,
    'el inventario coincide con las órdenes': () => taken === active,
  })
}
