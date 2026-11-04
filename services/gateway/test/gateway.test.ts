import { generateKeyPairSync, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRedis, createTokenVerifier, waitForRedis, type Redis } from '@ticketflow/common'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'

type App = Awaited<ReturnType<typeof buildApp>>

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const verifyToken = createTokenVerifier({ key: publicKey, issuer: 'ticketflow-auth', audience: 'ticketflow' })

const signToken = (userId = randomUUID()) =>
  new SignJWT({ role: 'customer' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(userId)
    .setIssuer('ticketflow-auth')
    .setAudience('ticketflow')
    .setExpirationTime('5m')
    .sign(privateKey)

interface Received {
  service: string
  method: string
  url: string
  headers: Record<string, string>
}

/** Servicio falso que responde con lo que recibió, para inspeccionar qué reenvía el gateway. */
async function fakeUpstream(service: string, log: Received[]) {
  const upstream = Fastify()
  upstream.all('/*', async (req) => {
    const entry = { service, method: req.method, url: req.url, headers: req.headers as Record<string, string> }
    log.push(entry)
    return entry
  })
  await upstream.listen({ port: 0, host: '127.0.0.1' })
  const { port } = upstream.server.address() as { port: number }
  return { upstream, url: `http://127.0.0.1:${port}` }
}

let redis: Redis
const SERVICES = ['auth', 'events', 'orders', 'payments'] as const
let upstreams: FastifyInstance[] = []
let urls: Record<(typeof SERVICES)[number], string>
let received: Received[]
let app: App

const gatewayConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    REDIS_URL: process.env.TEST_REDIS_URL,
    AUTH_SERVICE_URL: urls.auth,
    EVENTS_SERVICE_URL: urls.events,
    ORDERS_SERVICE_URL: urls.orders,
    PAYMENTS_SERVICE_URL: urls.payments,
    ...overrides,
  })

beforeAll(async () => {
  received = []
  const started = await Promise.all(SERVICES.map((s) => fakeUpstream(s, received)))
  upstreams = started.map((s) => s.upstream)
  urls = Object.fromEntries(SERVICES.map((s, i) => [s, started[i]!.url])) as typeof urls
  redis = createRedis(process.env.TEST_REDIS_URL!)
  await waitForRedis(redis)
})

beforeEach(async () => {
  received.length = 0
  await redis.flushdb()
  app = await buildApp(gatewayConfig(), { redis, verifyToken })
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await Promise.all(upstreams.map((u) => u.close()))
  redis.disconnect()
})

describe('ruteo', () => {
  it.each([
    ['POST', '/auth/login', 'auth'],
    ['GET', '/.well-known/jwks.json', 'auth'],
    ['GET', '/events?city=Rosario&limit=5', 'events'],
    ['POST', '/events/123/publish', 'events'],
    ['GET', '/organizer/events', 'events'],
    ['POST', '/orders', 'orders'],
    ['POST', '/orders/abc/cancel', 'orders'],
    ['GET', '/availability/abc/sections/def', 'orders'],
    ['POST', '/payments/abc/pay', 'payments'],
    ['POST', '/webhooks/psp', 'payments'],
  ] as const)('%s %s → %s-service', async (method, url, service) => {
    const res = await app.inject({ method, url })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ service, method, url })
  })

  it('devuelve 404 uniforme para rutas que no existen', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-existe' })
    expect(res.json().error.code).toBe('ROUTE_NOT_FOUND')
    expect(received).toHaveLength(0)
  })
})

describe('request id', () => {
  it('reenvía el x-request-id que recibe', async () => {
    const res = await app.inject({ method: 'GET', url: '/events', headers: { 'x-request-id': 'abc-123' } })

    expect(res.headers['x-request-id']).toBe('abc-123')
    expect(received[0]!.headers['x-request-id']).toBe('abc-123')
  })

  it('genera uno si no viene y el servicio recibe el mismo', async () => {
    const res = await app.inject({ method: 'GET', url: '/events' })

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(received[0]!.headers['x-request-id']).toBe(res.headers['x-request-id'])
  })
})

describe('IP del cliente', () => {
  it('reenvía la IP real y descarta un X-Forwarded-For inventado por el cliente', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-for': '6.6.6.6' },
      remoteAddress: '198.51.100.7',
    })
    expect(received[0]!.headers['x-forwarded-for']).toBe('198.51.100.7')
  })
})

describe('autenticación en el borde', () => {
  it('rechaza tokens inválidos sin llegar al servicio', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/events',
      headers: { authorization: 'Bearer token.falso.firmado' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('INVALID_TOKEN')
    expect(received).toHaveLength(0)
  })

  it('reenvía el token válido para que el servicio también lo verifique', async () => {
    const token = await signToken()
    await app.inject({ method: 'GET', url: '/organizer/events', headers: { authorization: `Bearer ${token}` } })
    expect(received[0]!.headers.authorization).toBe(`Bearer ${token}`)
  })

  it('no valida tokens en las rutas de auth (las resuelve auth-service)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: 'Bearer token-vencido' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('rate limiting distribuido', () => {
  beforeEach(async () => {
    await app.close()
    app = await buildApp(gatewayConfig({ RATE_LIMIT_MAX: '3' }), { redis, verifyToken })
  })

  const getAs = (gateway: App, token?: string) =>
    gateway.inject({
      method: 'GET',
      url: '/events',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })

  it('limita por usuario y no afecta a otros usuarios', async () => {
    const [ana, beto] = await Promise.all([signToken(), signToken()])

    const anaStatuses = []
    for (let i = 0; i < 4; i++) anaStatuses.push((await getAs(app, ana)).statusCode)

    expect(anaStatuses).toEqual([200, 200, 200, 429])
    expect((await getAs(app, beto)).statusCode).toBe(200)
  })

  it('responde 429 con formato uniforme y headers informativos', async () => {
    for (let i = 0; i < 3; i++) await getAs(app)
    const res = await getAs(app)

    expect(res.statusCode).toBe(429)
    expect(res.json().error.code).toBe('RATE_LIMITED')
    expect(res.headers['retry-after']).toBeDefined()
  })

  it('el límite se comparte entre réplicas del gateway (contadores en Redis)', async () => {
    const replica = await buildApp(gatewayConfig({ RATE_LIMIT_MAX: '3' }), { redis, verifyToken })
    const token = await signToken()

    const statuses = [
      (await getAs(app, token)).statusCode,
      (await getAs(replica, token)).statusCode,
      (await getAs(app, token)).statusCode,
      (await getAs(replica, token)).statusCode,
    ]
    await replica.close()

    expect(statuses).toEqual([200, 200, 200, 429])
  })

  it('si Redis se cae, deja pasar el tráfico (fail-open)', async () => {
    const deadRedis = createRedis('redis://127.0.0.1:6390')
    deadRedis.on('error', () => {})
    const degraded = await buildApp(gatewayConfig({ RATE_LIMIT_MAX: '1' }), { redis: deadRedis, verifyToken })

    const statuses = [(await getAs(degraded)).statusCode, (await getAs(degraded)).statusCode]
    await degraded.close()
    deadRedis.disconnect()

    expect(statuses).toEqual([200, 200])
  })
})

describe('fallas de los servicios', () => {
  it('si un servicio está caído responde 503 con formato uniforme', async () => {
    const broken = await buildApp(gatewayConfig({ EVENTS_SERVICE_URL: 'http://127.0.0.1:9' }), {
      redis,
      verifyToken,
    })
    const res = await broken.inject({ method: 'GET', url: '/events' })
    await broken.close()

    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE')
  })

  it('readiness refleja el estado de cada dependencia', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.json()).toEqual({
      status: 'ok',
      checks: {
        redis: 'ok',
        'auth-service': 'ok',
        'events-service': 'ok',
        'orders-service': 'ok',
        'payments-service': 'ok',
      },
    })
  })
})

describe('CORS', () => {
  it('responde el preflight del navegador', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/events',
      headers: { origin: 'https://ticketflow.app', 'access-control-request-method': 'POST' },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('https://ticketflow.app')
  })
})
